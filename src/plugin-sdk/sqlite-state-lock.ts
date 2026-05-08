import { randomUUID } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type LockRow = {
  value_json: string;
};

type LockValue = {
  owner: string;
  expiresAt: number;
};

type LockDatabase = Pick<OpenClawStateKyselyDatabase, "kv">;

export type OpenClawStateLockRetryOptions = {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  randomize?: boolean;
};

export type OpenClawStateLockOptions = OpenClawStateDatabaseOptions & {
  scope?: string;
  stale?: number;
  retries?: OpenClawStateLockRetryOptions;
};

const DEFAULT_LOCK_SCOPE = "runtime.lock";
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_RETRY_OPTIONS: Required<OpenClawStateLockRetryOptions> = {
  retries: 10,
  factor: 1.2,
  minTimeout: 100,
  maxTimeout: 1000,
  randomize: true,
};

function parseLockValue(row: LockRow | undefined): LockValue | null {
  if (!row) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.value_json) as Partial<LockValue>;
    if (typeof parsed.owner === "string" && typeof parsed.expiresAt === "number") {
      return {
        owner: parsed.owner,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    // Invalid lock rows are treated as stale and overwritten by the next acquirer.
  }
  return null;
}

function resolveRetryOptions(
  options: OpenClawStateLockRetryOptions | undefined,
): Required<OpenClawStateLockRetryOptions> {
  return {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };
}

function resolveRetryDelayMs(
  attempt: number,
  options: Required<OpenClawStateLockRetryOptions>,
): number {
  const base = Math.min(options.maxTimeout, options.minTimeout * options.factor ** attempt);
  if (!options.randomize) {
    return base;
  }
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryAcquireOpenClawStateLock(params: {
  key: string;
  owner: string;
  scope: string;
  staleMs: number;
  options: OpenClawStateDatabaseOptions;
}): boolean {
  const now = Date.now();
  const expiresAt = now + params.staleMs;
  return runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<LockDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync<LockRow>(
      database.db,
      db
        .selectFrom("kv")
        .select(["value_json"])
        .where("scope", "=", params.scope)
        .where("key", "=", params.key),
    );
    const current = parseLockValue(row);
    if (current && current.expiresAt > now && current.owner !== params.owner) {
      return false;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("kv")
        .values({
          scope: params.scope,
          key: params.key,
          value_json: JSON.stringify({ owner: params.owner, expiresAt }),
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["scope", "key"]).doUpdateSet({
            value_json: JSON.stringify({ owner: params.owner, expiresAt }),
            updated_at: now,
          }),
        ),
    );
    return true;
  }, params.options);
}

function releaseOpenClawStateLock(params: {
  key: string;
  owner: string;
  scope: string;
  options: OpenClawStateDatabaseOptions;
}): void {
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<LockDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync<LockRow>(
      database.db,
      db
        .selectFrom("kv")
        .select(["value_json"])
        .where("scope", "=", params.scope)
        .where("key", "=", params.key),
    );
    const current = parseLockValue(row);
    if (current?.owner !== params.owner) {
      return;
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("kv").where("scope", "=", params.scope).where("key", "=", params.key),
    );
  }, params.options);
}

export async function withOpenClawStateLock<T>(
  key: string,
  options: OpenClawStateLockOptions,
  task: () => Promise<T>,
): Promise<T> {
  const owner = randomUUID();
  const scope = options.scope ?? DEFAULT_LOCK_SCOPE;
  const staleMs = Math.max(1, options.stale ?? DEFAULT_STALE_MS);
  const retries = resolveRetryOptions(options.retries);
  const databaseOptions: OpenClawStateDatabaseOptions = {
    env: options.env,
    path: options.path,
  };

  for (let attempt = 0; attempt <= retries.retries; attempt += 1) {
    if (
      tryAcquireOpenClawStateLock({
        key,
        owner,
        scope,
        staleMs,
        options: databaseOptions,
      })
    ) {
      try {
        return await task();
      } finally {
        releaseOpenClawStateLock({ key, owner, scope, options: databaseOptions });
      }
    }
    if (attempt === retries.retries) {
      break;
    }
    await sleep(resolveRetryDelayMs(attempt, retries));
  }

  throw new Error(`Timed out acquiring SQLite state lock ${scope}:${key}`);
}
