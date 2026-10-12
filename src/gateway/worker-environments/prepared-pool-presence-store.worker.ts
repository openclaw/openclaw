import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { readRepositoryWorkerProjectSnapshot } from "./repository-project-source.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";

const PREPARED_POOL_PRESENCE_STATE_KEY = "cloudWorkers.preparedPool.humanPresenceDemand";

type StateDatabase = Pick<DB, "config_machine_state">;

function parsePresenceDemand(value: unknown): PreparedPoolPresenceDemand {
  if (!isRecord(value)) {
    throw new Error("Prepared-pool presence demand is invalid");
  }
  const candidate = value;
  const revision = candidate.revision;
  const profileId = candidate.profileId;
  const requestedRef = candidate.requestedRef;
  const preparationKey = candidate.preparationKey;
  const lastPresentAtMs = candidate.lastPresentAtMs;
  const retireAtMs = candidate.retireAtMs;
  let project: RepositoryWorkerProjectSnapshot | undefined;
  try {
    project = readRepositoryWorkerProjectSnapshot(candidate.project);
  } catch {
    throw new Error("Prepared-pool presence demand is invalid");
  }
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof profileId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(profileId) ||
    (requestedRef !== null &&
      (typeof requestedRef !== "string" || !requestedRef || requestedRef.length > 1024)) ||
    typeof preparationKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(preparationKey) ||
    !project ||
    typeof lastPresentAtMs !== "number" ||
    !Number.isSafeInteger(lastPresentAtMs) ||
    lastPresentAtMs < 0 ||
    (retireAtMs !== null &&
      (typeof retireAtMs !== "number" ||
        !Number.isSafeInteger(retireAtMs) ||
        retireAtMs < lastPresentAtMs))
  ) {
    throw new Error("Prepared-pool presence demand is invalid");
  }
  return {
    revision,
    profileId,
    requestedRef,
    preparationKey,
    project,
    lastPresentAtMs,
    retireAtMs,
  };
}

export function readPreparedPoolPresenceDemandInDatabase(
  database: DatabaseSync,
): PreparedPoolPresenceDemand | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<StateDatabase>(database)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", PREPARED_POOL_PRESENCE_STATE_KEY),
  );
  if (!row) {
    return undefined;
  }
  if (row.value_json.length > 32_768) {
    throw new Error("Prepared-pool presence demand exceeds its record budget");
  }
  return parsePresenceDemand(JSON.parse(row.value_json));
}

export function writePreparedPoolPresenceDemandInDatabase(
  database: DatabaseSync,
  value: PreparedPoolPresenceDemand | null,
): PreparedPoolPresenceDemand | undefined {
  const db = getNodeSqliteKysely<StateDatabase>(database);
  if (value === null) {
    executeSqliteQuerySync(
      database,
      db
        .deleteFrom("config_machine_state")
        .where("state_key", "=", PREPARED_POOL_PRESENCE_STATE_KEY),
    );
    return undefined;
  }
  const prepared = parsePresenceDemand(value);
  const valueJson = JSON.stringify(prepared);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("config_machine_state")
      .values({
        state_key: PREPARED_POOL_PRESENCE_STATE_KEY,
        value_json: valueJson,
        updated_at_ms: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: valueJson,
          updated_at_ms: Date.now(),
        }),
      ),
  );
  return prepared;
}
