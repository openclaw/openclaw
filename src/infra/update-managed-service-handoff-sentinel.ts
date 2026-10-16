import { parentPort, workerData } from "node:worker_threads";
import { createConfigIO } from "../config/io.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { callGateway } from "../gateway/call.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
} from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { readActiveGatewayLockIdentity } from "./gateway-lock.js";
import { assertGatewayOwnerLeaseStopped } from "./gateway-owner-lease.js";
import { acquireStateDatabaseSchemaLease } from "./gateway-state-owner.js";
import {
  inspectManagedHandoffSentinel,
  recordManagedHandoffSentinelOutcome,
} from "./restart-sentinel.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";

export type ManagedHandoffSentinelOperation =
  | { kind: "inspect"; input: Parameters<typeof inspectManagedHandoffSentinel>[0] }
  | { kind: "record"; input: Parameters<typeof recordManagedHandoffSentinelOutcome>[0] };
export type ManagedHandoffSentinelRequest = {
  operation: ManagedHandoffSentinelOperation;
  databaseIdentity: ManagedUpdateLeaseDatabaseIdentity;
  helper: ManagedHandoffLease["helper"];
};

/** Classify without credentials; only a fresh TS runtime resolves the PostgreSQL connection. */
export async function resolveManagedHandoffStateEngine(env: NodeJS.ProcessEnv) {
  const selected = getDatabaseEngineSelection();
  if (selected) {
    return selected.effectiveEngines.state;
  }
  const [{ WorkerTaskPool }, { captureRuntimeWorkerSource }] = await Promise.all([
    import("./worker-task-pool.js"),
    import("./runtime-worker-generation.js"),
  ]);
  const source = captureRuntimeWorkerSource(new URL(import.meta.url));
  const pool = new WorkerTaskPool<string, "sqlite" | "postgres" | undefined>({
    workerUrl: source.moduleUrl,
    maxWorkers: 1,
    workerOptions: { workerData: { managedHandoffEngine: true } },
  });
  try {
    if ((await pool.run(resolveOpenClawStateSqlitePath(env), {})) === "postgres") {
      return "postgres";
    }
  } finally {
    await pool.close();
  }
  const snapshot = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot({ observe: false, isolateEnv: true });
  return resolveDatabaseFamilyEngines(snapshot.config).state;
}

if (parentPort && workerData?.managedHandoffEngine === true) {
  const [{ existsSync }, { readBackupEngine }, { serveWorkerTasks }] = await Promise.all([
    import("node:fs"),
    import("../snapshot/database-backup.js"),
    import("./worker-task-server.js"),
  ]);
  // Snapshot inspection may copy a large SQLite file; keep it off the calling thread.
  serveWorkerTasks((pathname) => {
    if (typeof pathname !== "string") {
      throw new Error("Invalid managed handoff state path");
    }
    return existsSync(pathname) ? readBackupEngine(pathname).engine : undefined;
  });
}

function prepareAuthority(input: ManagedHandoffSentinelRequest, child = false) {
  if (input.databaseIdentity.databasePath !== resolveManagedUpdateLeaseDatabasePath()) {
    throw new Error("Managed handoff sentinel lease store is not the local owner");
  }
  const store = createManagedHandoffLeaseStore({
    databasePath: input.databaseIdentity.databasePath,
    existingIdentity: input.databaseIdentity,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  return () => {
    const current = store.read(input.operation.input.root);
    const lease = current.kind === "current" ? current.lease : undefined;
    if (
      !lease ||
      lease.action.kind !== "update" ||
      lease.owner !== input.operation.input.handoffId ||
      lease.helper.pid !== input.helper.pid ||
      lease.helper.startIdentity !== input.helper.startIdentity ||
      lease.helper.startIdentitySource !== input.helper.startIdentitySource ||
      !store.isProcessIdentityCurrent(lease.helper) ||
      (child && lease.executor.pid !== process.pid) ||
      !(
        store.isProcessIdentityCurrent(lease.executor) ||
        (child && process.connected && store.acceptParentBoundExecutor(lease))
      )
    ) {
      throw new Error("Managed handoff sentinel writer lost its lease");
    }
  };
}

function executeOperation(
  operation: ManagedHandoffSentinelOperation,
  assertCurrent: () => void,
  env: NodeJS.ProcessEnv,
) {
  return operation.kind === "inspect"
    ? inspectManagedHandoffSentinel(operation.input, env, assertCurrent)
    : recordManagedHandoffSentinelOutcome(operation.input, env, assertCurrent);
}

/** Parent IPC and successor RPC share the same effect-time lease authority and policy. */
export function runManagedHandoffSentinelOwnerRequest(
  input: ManagedHandoffSentinelRequest,
  env: NodeJS.ProcessEnv = process.env,
  assertRequestCurrent?: () => void,
) {
  const assertLease = prepareAuthority(input);
  const assertCurrent = () => {
    assertRequestCurrent?.();
    assertLease();
  };
  assertCurrent();
  return executeOperation(input.operation, assertCurrent, env);
}

/** A new installed-runtime process owns config/driver loading after candidate schema changes. */
export async function executeInstalledHandoffSentinelOperation(
  input: ManagedHandoffSentinelRequest,
) {
  const assertCurrent = prepareAuthority(input, true);
  assertCurrent();
  const env = process.env;
  const snapshot = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot({ observe: false, isolateEnv: true });
  if (!snapshot.valid) {
    throw new Error("Managed handoff sentinel config is invalid");
  }
  installDatabaseEngineSelection(await resolveDatabaseEngineSelection(snapshot.config, env));
  if (getDatabaseEngineSelection()!.effectiveEngines.state !== "postgres") {
    throw new Error("Managed handoff engine changed before reporting");
  }
  const gateway = await readActiveGatewayLockIdentity({ env, requireInspection: true });
  assertCurrent();
  if (gateway) {
    return callGateway({
      method: "update.handoffSentinel",
      params: input,
      scopes: ["operator.admin"],
      localPortOverride: gateway.port,
      ignoreEnvUrlOverride: true,
      config: {
        ...snapshot.config,
        gateway: { ...snapshot.config.gateway, mode: "local", port: gateway.port },
      },
      timeoutMs: 10_000,
      assertDispatchCurrent: assertCurrent,
    });
  }
  const custody = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath(env), {
    busyTimeoutMs: 0,
  });
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {
      custody.assertCurrent();
      assertCurrent();
    },
    assertDatabaseAccess: custody.assertDatabaseAccess,
  });
  try {
    return await custody.run(() =>
      scope.run(async () => {
        await assertGatewayOwnerLeaseStopped(env, custody);
        return executeOperation(
          input.operation,
          () => {
            custody.assertCurrent();
            assertCurrent();
          },
          env,
        );
      }),
    );
  } finally {
    try {
      await scope.close();
    } finally {
      custody.release();
    }
  }
}
