import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import type { OpenClawStateSchemaReadAdmission } from "../state/openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { startOpenClawStateLeaseHeartbeat } from "../state/openclaw-state-lease-heartbeat.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLease,
  reclaimDeadOpenClawStateLeaseInTransaction,
  releaseOpenClawStateLeaseInTransaction,
} from "../state/openclaw-state-lease-store.js";
import { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { STARTUP_MIGRATION_LEASE_TTL_MS } from "./startup-migration-checkpoint.js";
import {
  parseStateLeaseProcessOwner,
  readStateLeaseProcessOwnerStatus,
  type StateLeaseProcessOwner,
} from "./state-lease-process-owner.js";

const gatewayOwnerKey = { scope: "gateway-owner", key: "global" };
const log = createSubsystemLogger("gateway");

export type GatewayOwnerSupervisor = {
  kind: "launchd" | "systemd" | "schtasks" | "external";
  name: string | null;
};

export type GatewayOwnerLeaseIdentity = StateLeaseProcessOwner & {
  owner: string;
  port: number;
  mode: "foreground" | "supervised";
  supervisor: GatewayOwnerSupervisor | null;
  state: "live" | "dead" | "unknown";
  expired: boolean;
};

export type GatewayOwnerLease = {
  owner: string;
  ready: Promise<void>;
  release: () => Promise<void>;
};

function parseSupervisor(value: unknown): GatewayOwnerSupervisor | null {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    (value.kind !== "launchd" &&
      value.kind !== "systemd" &&
      value.kind !== "schtasks" &&
      value.kind !== "external") ||
    (value.name !== null && (typeof value.name !== "string" || !value.name.trim()))
  ) {
    throw new Error("Gateway owner lease supervisor could not be verified");
  }
  return { kind: value.kind, name: value.name };
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
  const operation = ({
    db,
  }: {
    db: import("node:sqlite").DatabaseSync;
  }): GatewayOwnerLeaseIdentity | undefined => {
    if (!tableExists(db, "state_leases")) {
      return undefined;
    }
    const row = readOpenClawStateLease(db, gatewayOwnerKey);
    if (!row) {
      return undefined;
    }
    const processOwner = parseStateLeaseProcessOwner(row.payloadJson);
    let payload: unknown;
    try {
      payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
    } catch {
      payload = null;
    }
    if (
      !processOwner ||
      !isRecord(payload) ||
      typeof payload.port !== "number" ||
      !Number.isInteger(payload.port) ||
      payload.port <= 0 ||
      payload.port > 65535 ||
      (payload.mode !== "foreground" && payload.mode !== "supervised")
    ) {
      throw new Error("Gateway owner lease identity could not be verified");
    }
    if (params.port !== undefined && payload.port !== params.port) {
      return undefined;
    }
    const supervisor = parseSupervisor(payload.supervisor);
    if ((payload.mode === "foreground") !== (supervisor === null)) {
      throw new Error("Gateway owner lease supervisor does not match its listener mode");
    }
    return {
      ...processOwner,
      owner: row.owner,
      port: payload.port,
      mode: payload.mode,
      supervisor,
      // Expiry cannot revoke the separate physical Gateway coordinator.
      state: readStateLeaseProcessOwnerStatus(processOwner),
      expired: row.expiresAt === null || row.expiresAt <= Date.now(),
    };
  };
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
      runSqliteImmediateTransactionSync(db, () => {
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
      }),
    { env, path: databasePath },
  );
  const releaseRow = () =>
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) =>
        runSqliteImmediateTransactionSync(db, () => {
          assertOpenClawStateWriteAllowed({ database: db, databasePath, env });
          releaseOpenClawStateLeaseInTransaction(db, identity);
        }),
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
        existingOnly: true,
        identity,
        leaseMs: STARTUP_MIGRATION_LEASE_TTL_MS,
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
      releaseRow();
      released = true;
    },
  };
}
