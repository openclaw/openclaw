// Host-owned SQLite leases serialize trusted plugin work across processes.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isSqliteLockError } from "../infra/sqlite-transaction.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  PluginStateLeaseError,
  type PluginStateLeaseContext,
  type PluginStateLeaseErrorCode,
  type PluginStateLeaseOptions,
} from "./plugin-state-lease.types.js";
import { validatePluginStoreKey, validatePluginStoreNamespace } from "./plugin-store-validation.js";

type LeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;
type AgentLeaseDatabase = Pick<OpenClawAgentKyselyDatabase, "state_leases">;

const ACQUIRE_BACKOFF = {
  initialMs: 25,
  maxMs: 250,
  factor: 1.5,
  jitter: 0.25,
} as const;
const MIN_LEASE_MS = 1_000;
const LEASE_DB_BUSY_TIMEOUT_MS = 0;
const RELEASE_RETRY_TIMEOUT_MS = 2_000;

function leaseError(
  code: PluginStateLeaseErrorCode,
  message: string,
  cause?: unknown,
): PluginStateLeaseError {
  return new PluginStateLeaseError(message, { code, ...(cause === undefined ? {} : { cause }) });
}

function invalidInput(message: string): PluginStateLeaseError {
  return leaseError("PLUGIN_STATE_LEASE_INVALID_INPUT", message);
}

function validateDuration(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.startsWith("core:") || normalized.includes("\0")) {
    throw invalidInput("plugin lease requires a non-core plugin id");
  }
  return normalized;
}

function validateOptions(pluginId: string, options: PluginStateLeaseOptions) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalidInput("plugin lease options must be an object");
  }
  if (typeof options.namespace !== "string") {
    throw invalidInput("plugin lease namespace must be a string");
  }
  if (typeof options.key !== "string") {
    throw invalidInput("plugin lease key must be a string");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidInput("plugin lease signal must be an AbortSignal");
  }
  const errors = {
    invalid: (message: string) => invalidInput(message),
    limit: (message: string) => invalidInput(message),
  };
  const namespace = validatePluginStoreNamespace({
    value: options.namespace,
    label: "plugin lease",
    errors,
  });
  const key = validatePluginStoreKey({
    value: options.key,
    label: "plugin lease",
    errors,
  });
  const leaseMs = validateDuration(
    options.leaseMs,
    "plugin lease leaseMs",
    MIN_LEASE_MS,
    MAX_TIMER_TIMEOUT_MS,
  );
  const waitMs = validateDuration(options.waitMs, "plugin lease waitMs", 0, MAX_TIMER_TIMEOUT_MS);
  const database = options.database;
  if (typeof database !== "object" || database === null || Array.isArray(database)) {
    throw invalidInput("plugin lease database must be an object");
  }
  if (database.scope !== "shared" && database.scope !== "agent") {
    throw invalidInput("plugin lease database scope must be shared or agent");
  }
  if (database.scope === "agent") {
    if (typeof database.agentId !== "string" || !database.agentId.trim()) {
      throw invalidInput("plugin lease agent database requires a string agentId");
    }
  }
  return {
    scope: `plugin:${validatePluginId(pluginId)}:${namespace}`,
    key,
    leaseMs,
    waitMs,
    database,
    signal: options.signal,
  };
}

function readBusyTimeout(database: DatabaseSync): number {
  const row = database // sqlite-allow-raw -- Narrow connection primitive for bounded lease admission.
    .prepare("PRAGMA busy_timeout")
    .get() as { busy_timeout?: unknown; timeout?: unknown } | undefined;
  const value = row?.busy_timeout ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function withBusyTimeout<T>(database: DatabaseSync, busyTimeoutMs: number, run: () => T): T {
  const previousBusyTimeoutMs = readBusyTimeout(database);
  if (previousBusyTimeoutMs === busyTimeoutMs) {
    return run();
  }
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`); // sqlite-allow-raw -- Bound synchronous lease admission to waitMs.
  try {
    return run();
  } finally {
    if (database.isOpen) {
      database.exec(`PRAGMA busy_timeout = ${previousBusyTimeoutMs}`); // sqlite-allow-raw -- Restore canonical connection policy.
    }
  }
}

function withLeaseWriteTransaction<T>(
  database: PluginStateLeaseOptions["database"],
  operation: (db: DatabaseSync, kysely: ReturnType<typeof getNodeSqliteKysely<LeaseDatabase>>) => T,
  busyTimeoutMs = LEASE_DB_BUSY_TIMEOUT_MS,
): T {
  if (database.scope === "shared") {
    const stateDatabase = openOpenClawStateDatabase();
    const run = () =>
      runOpenClawStateWriteTransaction(
        ({ db }) => operation(db, getNodeSqliteKysely<LeaseDatabase>(db)),
        {},
        {
          operationLabel: "plugin-state.lease",
          busyTimeoutMs,
        },
      );
    return withBusyTimeout(stateDatabase.db, busyTimeoutMs, run);
  }
  const agentDatabase = openOpenClawAgentDatabase({ agentId: database.agentId });
  const run = () =>
    runOpenClawAgentWriteTransaction(
      ({ db }) => operation(db, getNodeSqliteKysely<AgentLeaseDatabase>(db)),
      { agentId: database.agentId },
      {
        operationLabel: "plugin-state.lease",
        busyTimeoutMs,
      },
    );
  return withBusyTimeout(agentDatabase.db, busyTimeoutMs, run);
}

function withLeaseRead<T>(
  database: PluginStateLeaseOptions["database"],
  operation: (db: DatabaseSync, kysely: ReturnType<typeof getNodeSqliteKysely<LeaseDatabase>>) => T,
): T {
  const sqlite =
    database.scope === "shared"
      ? openOpenClawStateDatabase().db
      : openOpenClawAgentDatabase({ agentId: database.agentId }).db;
  return operation(sqlite, getNodeSqliteKysely<LeaseDatabase>(sqlite));
}

function tryAcquire(params: {
  database: PluginStateLeaseOptions["database"];
  scope: string;
  key: string;
  owner: string;
  leaseMs: number;
}): number | undefined {
  return withLeaseWriteTransaction(params.database, (db, kysely) => {
    // BEGIN IMMEDIATE may wait on SQLite. Sample only after admission so a
    // successful insert never commits an already-expired lease.
    const now = Date.now();
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("state_leases")
        .where("scope", "=", params.scope)
        .where("lease_key", "=", params.key)
        .where("expires_at", "<=", now),
    );
    const expiresAt = now + params.leaseMs;
    const inserted = executeSqliteQuerySync(
      db,
      kysely
        .insertInto("state_leases")
        .values({
          scope: params.scope,
          lease_key: params.key,
          owner: params.owner,
          expires_at: expiresAt,
          heartbeat_at: now,
          payload_json: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
    );
    return inserted.numAffectedRows === 1n ? expiresAt : undefined;
  });
}

function renew(params: {
  database: PluginStateLeaseOptions["database"];
  scope: string;
  key: string;
  owner: string;
  leaseMs: number;
}): number {
  return withLeaseWriteTransaction(params.database, (db, kysely) => {
    const now = Date.now();
    const expiresAt = now + params.leaseMs;
    const updated = executeSqliteQuerySync(
      db,
      kysely
        .updateTable("state_leases")
        .set({
          expires_at: expiresAt,
          heartbeat_at: now,
          updated_at: now,
        })
        .where("scope", "=", params.scope)
        .where("lease_key", "=", params.key)
        .where("owner", "=", params.owner)
        .where("expires_at", ">", now),
    );
    if (updated.numAffectedRows !== 1n) {
      throw leaseError(
        "PLUGIN_STATE_LEASE_LOST",
        `plugin lease ${params.scope}/${params.key} was lost`,
      );
    }
    return expiresAt;
  });
}

function assertLeaseOwned(params: {
  database: PluginStateLeaseOptions["database"];
  scope: string;
  key: string;
  owner: string;
}): void {
  withLeaseRead(params.database, (db, kysely) => {
    const now = Date.now();
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("state_leases")
        .select("owner")
        .where("scope", "=", params.scope)
        .where("lease_key", "=", params.key)
        .where("owner", "=", params.owner)
        .where("expires_at", ">", now),
    );
    if (!row) {
      throw leaseError(
        "PLUGIN_STATE_LEASE_LOST",
        `plugin lease ${params.scope}/${params.key} was lost`,
      );
    }
  });
}

function verifyLeaseOwnership(params: {
  database: PluginStateLeaseOptions["database"];
  scope: string;
  key: string;
  owner: string;
}): void {
  try {
    assertLeaseOwned(params);
  } catch (error) {
    if (error instanceof PluginStateLeaseError) {
      throw error;
    }
    throw leaseError(
      "PLUGIN_STATE_LEASE_STORAGE_FAILED",
      `failed to verify plugin lease ${params.scope}/${params.key}`,
      error,
    );
  }
}

function release(params: {
  database: PluginStateLeaseOptions["database"];
  scope: string;
  key: string;
  owner: string;
}): void {
  withLeaseWriteTransaction(params.database, (db, kysely) => {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("state_leases")
        .where("scope", "=", params.scope)
        .where("lease_key", "=", params.key)
        .where("owner", "=", params.owner),
    );
  });
}

async function releaseBestEffort(params: Parameters<typeof release>[0]): Promise<void> {
  const deadline = performance.now() + RELEASE_RETRY_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    try {
      release(params);
      return;
    } catch (error) {
      if (!isSqliteLockError(error)) {
        return;
      }
      const now = performance.now();
      if (now >= deadline) {
        return;
      }
      attempt += 1;
      // Lease transactions never block the event loop. Cleanup instead gives
      // ordinary cross-process writers a bounded async window to finish.
      await sleepWithAbort(Math.min(deadline - now, computeBackoff(ACQUIRE_BACKOFF, attempt)));
    }
  }
}

function abortError(signal: AbortSignal, label: string): PluginStateLeaseError {
  return leaseError("PLUGIN_STATE_LEASE_ABORTED", `${label} was aborted`, signal.reason);
}

/** Run one trusted plugin operation under a host-owned SQLite lease. */
export async function withPluginStateLease<T>(
  pluginId: string,
  options: PluginStateLeaseOptions,
  run: (lease: PluginStateLeaseContext) => Promise<T>,
): Promise<T> {
  const validated = validateOptions(pluginId, options);
  if (validated.signal?.aborted) {
    throw abortError(validated.signal, "plugin lease acquisition");
  }
  const owner = randomUUID();
  // Acquisition budgets are elapsed-time contracts. Wall-clock changes still
  // affect persisted expiry timestamps, but must not lengthen or shorten waits.
  const deadline = performance.now() + validated.waitMs;
  let attempt = 0;
  let confirmedExpiresAt: number | undefined;
  while (confirmedExpiresAt === undefined) {
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "plugin lease acquisition");
    }
    try {
      confirmedExpiresAt = tryAcquire({
        database: validated.database,
        scope: validated.scope,
        key: validated.key,
        owner,
        leaseMs: validated.leaseMs,
      });
    } catch (error) {
      if (error instanceof PluginStateLeaseError) {
        throw error;
      }
      if (!isSqliteLockError(error)) {
        throw leaseError(
          "PLUGIN_STATE_LEASE_STORAGE_FAILED",
          `failed to acquire plugin lease ${validated.scope}/${validated.key}`,
          error,
        );
      }
    }
    const now = performance.now();
    if (confirmedExpiresAt !== undefined) {
      if (validated.signal?.aborted || (validated.waitMs > 0 && now >= deadline)) {
        await releaseBestEffort({
          database: validated.database,
          scope: validated.scope,
          key: validated.key,
          owner,
        });
        if (validated.signal?.aborted) {
          throw abortError(validated.signal, "plugin lease acquisition");
        }
        throw leaseError(
          "PLUGIN_STATE_LEASE_TIMEOUT",
          `timed out waiting for plugin lease ${validated.scope}/${validated.key}`,
        );
      }
      break;
    }
    if (now >= deadline) {
      throw leaseError(
        "PLUGIN_STATE_LEASE_TIMEOUT",
        `timed out waiting for plugin lease ${validated.scope}/${validated.key}`,
      );
    }
    attempt += 1;
    const delayMs = Math.min(deadline - now, computeBackoff(ACQUIRE_BACKOFF, attempt));
    try {
      await sleepWithAbort(delayMs, validated.signal);
    } catch (error) {
      if (validated.signal?.aborted) {
        throw abortError(validated.signal, "plugin lease acquisition");
      }
      throw error;
    }
  }

  const leaseLost = new AbortController();
  const operationSignal = validated.signal
    ? AbortSignal.any([validated.signal, leaseLost.signal])
    : leaseLost.signal;
  const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(validated.leaseMs / 3)));
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const abortLost = (cause?: unknown) => {
    if (!leaseLost.signal.aborted) {
      leaseLost.abort(
        cause instanceof PluginStateLeaseError
          ? cause
          : leaseError(
              "PLUGIN_STATE_LEASE_LOST",
              `plugin lease ${validated.scope}/${validated.key} expired`,
              cause,
            ),
      );
    }
  };
  const scheduleExpiry = () => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    expiryTimer = setTimeout(
      () => abortLost(),
      Math.max(1, (confirmedExpiresAt ?? Date.now()) - Date.now()),
    );
    expiryTimer.unref?.();
  };
  scheduleExpiry();
  const heartbeat = setInterval(() => {
    try {
      confirmedExpiresAt = renew({
        database: validated.database,
        scope: validated.scope,
        key: validated.key,
        owner,
        leaseMs: validated.leaseMs,
      });
      scheduleExpiry();
    } catch (error) {
      if (error instanceof PluginStateLeaseError && error.code === "PLUGIN_STATE_LEASE_LOST") {
        abortLost(error);
      } else if (confirmedExpiresAt !== undefined && Date.now() >= confirmedExpiresAt) {
        abortLost(error);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const assertOperationOwned = () => {
    if (leaseLost.signal.aborted) {
      throw leaseLost.signal.reason;
    }
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "plugin lease operation");
    }
    verifyLeaseOwnership({
      database: validated.database,
      scope: validated.scope,
      key: validated.key,
      owner,
    });
  };

  try {
    let result: T;
    try {
      if (validated.signal?.aborted) {
        throw abortError(validated.signal, "plugin lease operation");
      }
      // Acquisition and callback entry are separate scheduling points. A
      // suspended process must not enter after its persisted lease expires.
      assertOperationOwned();
      result = await run({
        signal: operationSignal,
        assertOwned: assertOperationOwned,
      });
    } catch (error) {
      if (leaseLost.signal.aborted) {
        throw leaseLost.signal.reason;
      }
      if (validated.signal?.aborted) {
        throw abortError(validated.signal, "plugin lease operation");
      }
      throw error;
    }
    if (leaseLost.signal.aborted) {
      throw leaseLost.signal.reason;
    }
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "plugin lease operation");
    }
    verifyLeaseOwnership({
      database: validated.database,
      scope: validated.scope,
      key: validated.key,
      owner,
    });
    return result;
  } finally {
    clearInterval(heartbeat);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    await releaseBestEffort({
      database: validated.database,
      scope: validated.scope,
      key: validated.key,
      owner,
    });
  }
}
