import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { readAgentDatabaseLeaseProvenance } from "../state/openclaw-agent-db-lease-provenance.js";
import type { OpenClawStateSchemaReadAdmission } from "../state/openclaw-state-db-contract.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import {
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import {
  existingPathOrUndefined,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import { startOpenClawStateLeaseHeartbeat } from "../state/openclaw-state-lease-heartbeat.js";
import {
  releaseOpenClawStateLeaseInTransaction,
  updateOpenClawStateLeasePayloadInTransaction,
} from "../state/openclaw-state-lease-store.js";
import { captureOpenClawStateReadSource } from "../state/openclaw-state-read-worker.js";
import type { OpenClawStateReadOutcome } from "../state/openclaw-state-read.types.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readProcessMachineIdentity } from "./current-machine-identity.js";
import {
  classifyGatewayOwnerProcessNamespace,
  describeGatewayLockHolder,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  GatewayLockNamespaceError,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { gatewayOwnerKey, readGatewayOwnerLeaseFromDatabase } from "./gateway-owner-lease.read.js";
import type {
  GatewayOwnerLeaseIdentity,
  GatewayOwnerSupervisor,
} from "./gateway-owner-lease.types.js";
import { captureGatewayStateOwner, type StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import type { EngineConnection } from "./sql-connection.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { retainSnapshotTempDirectory } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";
import {
  runSqliteImmediateTransactionSync,
  runSqliteSingleStatementSync,
} from "./sqlite-transaction.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "./startup-migration-checkpoint.js";
import { readStateLeaseProcessOwnerStatus } from "./state-lease-process-owner.js";

const log = createSubsystemLogger("gateway");

export type GatewayOwnerLease = {
  owner: string;
  ready: Promise<void>;
  markListening: () => void;
  release: () => Promise<void>;
};

function resolveStoppedGatewayOwnerLease(previous: GatewayOwnerLeaseIdentity | undefined) {
  if (!previous) {
    return undefined;
  }
  if (previous.state === "dead") {
    return previous;
  }
  const namespace = classifyGatewayOwnerProcessNamespace(previous.processNamespace, {
    ownerHost: previous.host,
    machineIdentity: previous.machineIdentity,
  });
  if (namespace === "dead") {
    return previous;
  }
  if (namespace === "unknown") {
    throw new GatewayLockNamespaceError(previous);
  }
  throw new Error(
    `Another Gateway owner lease is still active for this state directory: ${describeGatewayLockHolder(previous, undefined, previous.state === "live" ? "live" : "unknown")}`,
  );
}

/** Physical custody alone must not bypass a fresh, unverifiable lease. */
export async function assertGatewayOwnerLeaseStopped(
  env: NodeJS.ProcessEnv,
  owner: StateDatabaseSchemaLease,
  schemaMaintenance = false,
): Promise<void> {
  const pathname = resolveOpenClawStateSqlitePath(env);
  owner.assertDatabaseAccess(pathname);
  if (existingPathOrUndefined(pathname) === undefined) {
    return;
  }
  const context = captureOpenClawStateReadWorkerContext({ env, path: pathname });
  const source = captureOpenClawStateReadSource();
  const transport = source.createTransport({ type: "gatewayOwnerLease.read", schemaMaintenance });
  const controller = new AbortController();
  const callerSignal = getAsyncWorkSignal();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const authority = {
    signal,
    assertCurrent() {
      signal.throwIfAborted();
      context.maintenanceScope?.assertReadAdmission();
      context.admission.assertCurrent();
      owner.assertDatabaseAccess(pathname);
    },
  };
  let prepared: PreparedSqliteReadOnlyLocation | undefined;
  let releaseSnapshot: (() => void) | undefined;
  let read: Promise<OpenClawStateReadOutcome> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      // Read failure belongs to the caller; cleanup must still retire its native task.
      await read?.catch(() => undefined);
      await transport.startClose();
      releaseSnapshot?.();
      releaseSnapshot = undefined;
      if (prepared) {
        // Disposable cleanup warnings and retries belong to the snapshot owner.
        await prepared.cleanupAsync();
        prepared = undefined;
      }
      releaseSource();
    })().finally(() => {
      closing = undefined;
    }));
  const releaseSource = source.own(() => {
    controller.abort();
    return close();
  });
  const errors: unknown[] = [];
  let outcome: OpenClawStateReadOutcome | undefined;
  try {
    authority.assertCurrent();
    if (schemaMaintenance && !isStatePostgres()) {
      prepared = prepareSqliteReadOnlyLocationSync(pathname);
      releaseSnapshot = retainSnapshotTempDirectory(
        prepared.cleanupRoot ?? path.dirname(prepared.location),
      );
    }
    read = transport.startRead(
      {
        context,
        // Offline custody permits a direct worker read; only repair needs a private snapshot.
        location: prepared?.location ?? pathname,
        snapshotRoot: prepared?.cleanupRoot,
        checkFreshAdmission: false,
      },
      authority,
    );
    outcome = await read;
    if ("error" in outcome) {
      errors.push(outcome.error);
    }
    authority.assertCurrent();
  } catch (error) {
    errors.push(error);
  }
  const cleanupErrors: unknown[] = [];
  try {
    await close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    authority.assertCurrent();
    if (outcome && "value" in outcome) {
      const reply = outcome.value;
      if (reply.type !== "gatewayOwnerLease.read") {
        throw new Error("Unexpected Gateway owner lease inspection result");
      }
      resolveStoppedGatewayOwnerLease(
        reply.lease
          ? {
              ...reply.lease,
              state: readStateLeaseProcessOwnerStatus(reply.lease, reply.lease.heartbeatAt),
            }
          : undefined,
      );
    }
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(
    [...errors, ...cleanupErrors],
    "Gateway owner lease inspection and cleanup failed",
  );
}

export function readGatewayOwnerLease(
  params: {
    env?: NodeJS.ProcessEnv;
    port?: number;
    /** Mutation admission must not inherit a discovery snapshot. */
    current?: boolean;
    openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission;
  } = {},
): GatewayOwnerLeaseIdentity | undefined {
  const operation = ({ db }: { db: EngineConnection }) =>
    readGatewayOwnerLeaseFromDatabase(db, params.port);
  return params.current || params.openStateSchemaReadAdmission
    ? withExistingOpenClawStateDatabaseCurrentReadOnly(
        operation,
        { env: params.env },
        params.openStateSchemaReadAdmission,
      )
    : withExistingOpenClawStateDatabaseReadOnly(operation, { env: params.env });
}

/** Publish only while the caller holds the Gateway lifecycle coordinator. */
export function acquireGatewayOwnerLease(params: {
  env?: NodeJS.ProcessEnv;
  port: number;
  mode: GatewayOwnerLeaseIdentity["mode"];
  supervisor: GatewayOwnerSupervisor | null;
  owner?: string;
}): GatewayOwnerLease {
  const env = params.env ?? process.env;
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const custody = captureGatewayStateOwner(databasePath);
  const identity = { ...gatewayOwnerKey, owner: params.owner ?? randomUUID() };
  const processOwner = {
    pid: process.pid,
    host: hostname(),
    processNamespace: readGatewayLockProcessNamespace(),
    machineIdentity: process.platform === "darwin" ? readProcessMachineIdentity() : undefined,
    // Retry the native self lookup with its full Windows budget before publication.
    startedAt:
      getFileLockProcessStartTime(process.pid, env) ??
      getFileLockProcessStartTime(process.pid, env),
  };
  const payload = {
    owner: processOwner,
    port: params.port,
    mode: params.mode,
    supervisor: params.supervisor,
  };
  const payloadJson = JSON.stringify(payload);
  const mutateLease = <T>(
    operation: "acquire" | "release" | "listening",
    mutate: (db: EngineConnection) => T,
  ) =>
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) =>
        // Compound operations join the admitted owner's transaction; native
        // checkpoint bootstrap still needs its own envelope here.
        db.isTransaction
          ? mutate(db)
          : operation === "release"
            ? runSqliteSingleStatementSync(db, () => mutate(db))
            : runSqliteImmediateTransactionSync(db, () => mutate(db), {
                databaseLabel: databasePath,
                operationLabel: `gateway.owner-lease.${operation}`,
              }),
      {
        env,
        path: databasePath,
        sealOnClose: operation === "release",
        singleStatement: operation === "release" ? true : undefined,
      },
    );
  const expiresAt = mutateLease("acquire", (db) => {
    const previous = resolveStoppedGatewayOwnerLease(readGatewayOwnerLeaseFromDatabase(db));
    const now = Date.now();
    const leaseExpiresAt = now + STARTUP_MIGRATION_LEASE_TTL_MS;
    const values = {
      scope: identity.scope,
      lease_key: identity.key,
      owner: identity.owner,
      expires_at: leaseExpiresAt,
      heartbeat_at: now,
      payload_json: payloadJson,
      created_at: now,
      updated_at: now,
    };
    const acquired = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
        .insertInto("state_leases")
        .values(values)
        .onConflict((conflict) =>
          conflict
            .columns(["scope", "lease_key"])
            .doUpdateSet(values)
            .where("state_leases.owner", "=", previous?.owner ?? identity.owner),
        )
        .returning("expires_at"),
    );
    if (!acquired) {
      throw new Error("Another Gateway owner lease is still active for this state directory");
    }
    return leaseExpiresAt;
  });
  let heartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;
  let constructionFailure: { error: unknown } | undefined;
  let warned = false;
  const ready = (async () => {
    try {
      // Start outside the write transaction so the worker never retains its lifecycle gate.
      heartbeat = startOpenClawStateLeaseHeartbeat({
        path: databasePath,
        identity,
        leaseMs: STARTUP_MIGRATION_LEASE_TTL_MS,
        acquiredAt: expiresAt - STARTUP_MIGRATION_LEASE_TTL_MS,
        expiresAt,
        // Keep holder diagnostics fresh even when its process namespace is not visible.
        heartbeatMs: Math.floor(
          Math.min(STARTUP_MIGRATION_LEASE_TTL_MS, GATEWAY_OWNER_HEARTBEAT_STALE_MS) / 3,
        ),
        ...(processOwner.startedAt === null
          ? { processOwner: { identity: processOwner, env: resolveDiagnosticProcessEnv(env) } }
          : {}),
        onLost: () => {
          if (!warned) {
            warned = true;
            log.warn("Gateway owner lease heartbeat stopped; process identity remains recorded");
          }
        },
      });
    } catch (error) {
      constructionFailure = { error };
      throw error;
    }
    await heartbeat.ready;
  })();
  let released = false;
  return {
    owner: identity.owner,
    ready,
    markListening() {
      mutateLease("listening", (db) => {
        custody?.assertCurrent();
        // A heartbeat can repair an initially unavailable process start time.
        const startedAt =
          processOwner.startedAt ?? readGatewayOwnerLeaseFromDatabase(db)?.startedAt ?? null;
        const updated = updateOpenClawStateLeasePayloadInTransaction(
          db,
          identity,
          JSON.stringify({
            ...payload,
            owner: { ...processOwner, startedAt },
            listeningAt: Date.now(),
            // Listening follows startup admission. Peers trust this live owner of the exact file.
            stateDatabaseProvenance: readAgentDatabaseLeaseProvenance(databasePath),
          }),
        );
        if (!updated) {
          throw new Error("Gateway owner changed before listening publication");
        }
      });
    },
    async release() {
      if (released) {
        return;
      }
      if (constructionFailure) {
        // Construction did not return cleanup custody; keep the physical owner held.
        throw new Error("Gateway owner heartbeat cleanup could not be confirmed", {
          cause: constructionFailure.error,
        });
      }
      await heartbeat?.stop();
      try {
        // Lost custody may join its worker, but cannot mutate the recorded lease.
        if (!custody?.signal.aborted) {
          mutateLease("release", (db) => {
            releaseOpenClawStateLeaseInTransaction(db, identity);
          });
        }
      } catch (error) {
        if (!custody?.signal.aborted) {
          throw error;
        }
      }
      released = true;
    },
  };
}
