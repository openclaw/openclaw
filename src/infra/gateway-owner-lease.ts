import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import type { OpenClawStateSchemaReadAdmission } from "../state/openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { startOpenClawStateLeaseHeartbeat } from "../state/openclaw-state-lease-heartbeat.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  reclaimDeadOpenClawStateLeaseInTransaction,
  releaseOpenClawStateLeaseInTransaction,
} from "../state/openclaw-state-lease-store.js";
import { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
import { gatewayOwnerKey, readGatewayOwnerLeaseFromDatabase } from "./gateway-owner-lease.read.js";
import type {
  GatewayOwnerLeaseIdentity,
  GatewayOwnerSupervisor,
} from "./gateway-owner-lease.types.js";
import { captureGatewayStateOwner } from "./gateway-state-owner.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "./startup-migration-checkpoint.js";

const log = createSubsystemLogger("gateway");

export type GatewayOwnerLease = {
  owner: string;
  ready: Promise<void>;
  release: () => Promise<void>;
};

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
  const expiresAt = withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) =>
      runSqliteImmediateTransactionSync(
        db,
        () => {
          assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
          reclaimDeadOpenClawStateLeaseInTransaction(db, identity);
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
        },
        {
          databaseLabel: databasePath,
          operationLabel: "gateway.owner-lease.acquire",
        },
      ),
    { env, path: databasePath },
  );
  const releaseRow = () =>
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
            releaseOpenClawStateLeaseInTransaction(db, identity);
          },
          {
            databaseLabel: databasePath,
            operationLabel: "gateway.owner-lease.release",
          },
        ),
      { env, path: databasePath },
    );
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
        heartbeatMs: 30_000,
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
          releaseRow();
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
