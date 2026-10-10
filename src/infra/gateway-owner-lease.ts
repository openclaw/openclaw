import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import type { OpenClawStateSchemaReadAdmission } from "../state/openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import {
  existingPathOrUndefined,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import { startOpenClawStateLeaseHeartbeat } from "../state/openclaw-state-lease-heartbeat.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  releaseOpenClawStateLeaseInTransaction,
} from "../state/openclaw-state-lease-store.js";
import { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
import { captureOpenClawStateReadSource } from "../state/openclaw-state-read-worker.js";
import type { OpenClawStateReadOutcome } from "../state/openclaw-state-read.types.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  classifyGatewayOwnerProcessNamespace,
  describeGatewayLockHolder,
  GATEWAY_OWNER_HEARTBEAT_MS,
  GatewayLockNamespaceError,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { gatewayOwnerKey, readGatewayOwnerLeaseFromDatabase } from "./gateway-owner-lease.read.js";
import type {
  GatewayOwnerLeaseIdentity,
  GatewayOwnerSupervisor,
} from "./gateway-owner-lease.types.js";
import { captureGatewayStateOwner, type StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { retainSnapshotTempDirectory } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "./startup-migration-checkpoint.js";
import { readStateLeaseProcessOwnerStatus } from "./state-lease-process-owner.js";

const log = createSubsystemLogger("gateway");

export type GatewayOwnerLease = {
  owner: string;
  ready: Promise<void>;
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
    readHeartbeatAt: () => previous.heartbeatAt,
  });
  if (namespace === "dead") {
    return previous;
  }
  if (namespace === "unknown") {
    throw new GatewayLockNamespaceError(previous);
  }
  if (previous.expired && previous.state !== "live") {
    return previous;
  }
  throw new Error(
    `Another Gateway owner lease is still active for this state directory: ${describeGatewayLockHolder(previous, undefined, previous.state === "live" ? "live" : "unknown")}`,
  );
}

/** Physical custody alone must not bypass a fresh, unverifiable lease during maintenance. */
export async function assertGatewayOwnerLeaseStopped(
  env: NodeJS.ProcessEnv,
  maintenanceOwner?: StateDatabaseSchemaLease,
): Promise<void> {
  if (maintenanceOwner) {
    const pathname = resolveOpenClawStateSqlitePath(env);
    maintenanceOwner.assertDatabaseAccess(pathname);
    if (existingPathOrUndefined(pathname) === undefined) {
      return;
    }
    const context = captureOpenClawStateReadWorkerContext({ env, path: pathname });
    const source = captureOpenClawStateReadSource();
    const transport = source.createTransport({ type: "doctor.gatewayOwnerLease.read" });
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
        maintenanceOwner.assertDatabaseAccess(pathname);
      },
    };
    let prepared: PreparedSqliteReadOnlyLocation | undefined;
    let releaseSnapshot: (() => void) | undefined;
    let read: RetainedOperation<OpenClawStateReadOutcome> | undefined;
    let retirement: RetainedOperation<void> | undefined;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        // Read failure belongs to the caller; cleanup must still retire its native task.
        await read?.result.catch(() => undefined);
        retirement = transport.startClose();
        await retirement.result;
        retirement = undefined;
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
    const releaseSource = source.own(
      () => {
        read?.service();
        retirement?.service();
      },
      () => {
        controller.abort();
        return close();
      },
    );
    const errors: unknown[] = [];
    let outcome: OpenClawStateReadOutcome | undefined;
    try {
      authority.assertCurrent();
      prepared = prepareSqliteReadOnlyLocationSync(pathname);
      releaseSnapshot = retainSnapshotTempDirectory(
        prepared.cleanupRoot ?? path.dirname(prepared.location),
      );
      read = transport.startRead(
        {
          context,
          location: prepared.location,
          snapshotRoot: prepared.cleanupRoot,
          // Physical maintenance custody admits this private copy before quarantine repair.
          checkFreshAdmission: false,
        },
        authority,
      );
      outcome = await read.result;
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
        if (reply.type !== "doctor.gatewayOwnerLease.read") {
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
    return;
  }
  withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) => {
      resolveStoppedGatewayOwnerLease(readGatewayOwnerLeaseFromDatabase(db));
    },
    { env },
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
  const operation = ({ db }: { db: DatabaseSync }) =>
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
    // Retry the native self lookup with its full Windows budget before publication.
    startedAt:
      getFileLockProcessStartTime(process.pid, env) ??
      getFileLockProcessStartTime(process.pid, env),
  };
  const payloadJson = JSON.stringify({
    owner: processOwner,
    port: params.port,
    mode: params.mode,
    supervisor: params.supervisor,
  });
  const mutateLease = <T>(operation: "acquire" | "release", mutate: (db: DatabaseSync) => T) =>
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
            return mutate(db);
          },
          {
            databaseLabel: databasePath,
            operationLabel: `gateway.owner-lease.${operation}`,
          },
        ),
      { env, path: databasePath },
    );
  const expiresAt = mutateLease("acquire", (db) => {
    const previous = resolveStoppedGatewayOwnerLease(readGatewayOwnerLeaseFromDatabase(db));
    if (previous) {
      releaseOpenClawStateLeaseInTransaction(db, { ...identity, owner: previous.owner });
    }
    const acquired = acquireOpenClawStateLeaseInTransaction(
      db,
      identity,
      STARTUP_MIGRATION_LEASE_TTL_MS,
      payloadJson,
    );
    if (acquired.kind === "held") {
      throw new Error("Another Gateway owner lease is still active for this state directory");
    }
    return acquired.expiresAt;
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
        heartbeatMs: GATEWAY_OWNER_HEARTBEAT_MS,
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
