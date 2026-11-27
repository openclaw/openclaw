import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseSemver } from "semver";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { invalidateSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { readSqliteUserVersion, writeSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { ABANDONED_UPDATE_RUN_MS } from "../infra/update-run-timeouts.js";
import { publishStateSchemaVersionAdmission } from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import type { DB } from "./openclaw-state-db.generated.js";

const TERMINAL_GRACE_MS = 5 * 60_000;
type PublicationDatabase = Pick<DB, "update_runs"> & {
  config_machine_state: DB["config_machine_state"] & { min_reader?: number | null };
};

export type StateSchemaPublicationBlocker = {
  runId: string;
  updaterVersion: string;
  publishAfterMs: number | null;
};

/** Only the 2026.9.2 release line reopens the ledger without the transaction fence. */
export function isUnfencedUpdateDriver(version: unknown): boolean {
  const parsed = typeof version === "string" ? parseSemver(version) : null;
  return parsed !== null && `${parsed.major}.${parsed.minor}.${parsed.patch}` === "2026.9.2";
}

/** Every unfenced driver must clear its own deadline; a newer run cannot hide an older one. */
export function readStateSchemaPublicationBlocker(
  db: DatabaseSync,
  nowMs = Date.now(),
): StateSchemaPublicationBlocker | undefined {
  if (!tableExists(db, "update_runs")) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<PublicationDatabase>(db)
      .selectFrom("update_runs")
      .select(["run_id", "before_json", "status", "updated_at_ms", "finished_at_ms"])
      .where((eb) =>
        eb.or([
          eb.and([
            eb("status", "=", "running"),
            eb("updated_at_ms", ">=", nowMs - ABANDONED_UPDATE_RUN_MS),
          ]),
          eb.and([
            eb("status", "!=", "running"),
            eb.or([
              eb("finished_at_ms", ">", nowMs - TERMINAL_GRACE_MS),
              eb("finished_at_ms", "is", null),
            ]),
          ]),
        ]),
      )
      .orderBy("run_id"),
  ).rows;
  let blocker: StateSchemaPublicationBlocker | undefined;
  for (const row of rows) {
    const before: unknown = JSON.parse(row.before_json);
    if (
      !isRecord(before) ||
      typeof before.version !== "string" ||
      !isUnfencedUpdateDriver(before.version)
    ) {
      continue;
    }
    const deadline =
      row.status === "running"
        ? row.updated_at_ms + ABANDONED_UPDATE_RUN_MS + 1
        : row.finished_at_ms === null
          ? null
          : row.finished_at_ms + TERMINAL_GRACE_MS;
    if (
      !blocker ||
      deadline === null ||
      (blocker.publishAfterMs !== null && deadline > blocker.publishAfterMs)
    ) {
      blocker = { runId: row.run_id, updaterVersion: before.version, publishAfterMs: deadline };
    }
  }
  return blocker;
}

/** Publish header, content and reader floor in the schema owner's transaction. */
export function resolveStateSchemaVersionToPublish(
  db: DatabaseSync,
  minReader = OPENCLAW_STATE_SCHEMA_VERSION,
): number {
  const published = readSqliteUserVersion(db);
  if (published > OPENCLAW_STATE_SCHEMA_VERSION) {
    return published;
  }
  const deferred =
    published < OPENCLAW_STATE_SCHEMA_VERSION &&
    readStateSchemaPublicationBlocker(db) !== undefined;
  if (deferred && !tableExists(db, "config_machine_state")) {
    throw new Error(
      "Shared state schema publication cannot be deferred without config_machine_state.",
    );
  }
  if (deferred || minReader < OPENCLAW_STATE_SCHEMA_VERSION) {
    writeStateSchemaContentVersion(db, minReader);
  } else {
    advanceStateSchemaContentVersion(db, { toVersion: OPENCLAW_STATE_SCHEMA_VERSION });
  }
  const version = deferred ? published : OPENCLAW_STATE_SCHEMA_VERSION;
  if (version !== published) {
    writeSqliteUserVersion(db, version);
  } else if (deferred) {
    invalidateSqliteSchemaFacts(db);
  }
  publishStateSchemaVersionAdmission(db, {
    userVersion: version,
    contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    ...(minReader < OPENCLAW_STATE_SCHEMA_VERSION ? { minReader } : {}),
  });
  return version;
}

function stateReaderFloor(
  db: EngineConnection,
  version: number,
  minReader: number,
): { min_reader?: number | null } {
  if (isPostgresSqlConnection(db)) {
    return {};
  }
  const explicit = minReader < version;
  if (explicit) {
    ensureColumn(db, "config_machine_state", "min_reader INTEGER");
  }
  return explicit || tableHasColumn(db, "config_machine_state", "min_reader")
    ? { min_reader: explicit ? minReader : null }
    : {};
}

/** Persist the content marker inside the schema owner's transaction. */
export function writeStateSchemaContentVersion(
  db: EngineConnection,
  minReader = OPENCLAW_STATE_SCHEMA_VERSION,
): void {
  if (
    !isPostgresSqlConnection(db) &&
    readStateSchemaContentVersion(db) > OPENCLAW_STATE_SCHEMA_VERSION
  ) {
    return;
  }
  const floor = stateReaderFloor(db, OPENCLAW_STATE_SCHEMA_VERSION, minReader);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<PublicationDatabase>(db)
      .insertInto("config_machine_state")
      .values({
        state_key: CONTENT_VERSION_KEY,
        value_json: String(OPENCLAW_STATE_SCHEMA_VERSION),
        ...floor,
        updated_at_ms: Date.now(),
      })
      .onConflict((conflict) =>
        conflict
          .column("state_key")
          .doUpdateSet({
            value_json: String(OPENCLAW_STATE_SCHEMA_VERSION),
            ...floor,
            updated_at_ms: Date.now(),
          })
          .where((eb) =>
            eb.or([
              eb("config_machine_state.value_json", "!=", String(OPENCLAW_STATE_SCHEMA_VERSION)),
              ...(floor.min_reader === undefined
                ? []
                : floor.min_reader === null
                  ? [eb("config_machine_state.min_reader", "is not", null)]
                  : [
                      eb("config_machine_state.min_reader", "is", null),
                      eb("config_machine_state.min_reader", "!=", floor.min_reader),
                    ]),
            ]),
          ),
      ),
  );
}

/** Advance an existing migration marker without changing its original timestamp. */
export function advanceStateSchemaContentVersion(
  db: EngineConnection,
  versions: { fromVersion?: number; toVersion: number; minReader?: number },
): void {
  if (!tableExists(db, "config_machine_state")) {
    return;
  }
  const floor = stateReaderFloor(db, versions.toVersion, versions.minReader ?? versions.toVersion);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<PublicationDatabase>(db)
      .updateTable("config_machine_state")
      .set({ value_json: String(versions.toVersion), ...floor })
      .where("state_key", "=", CONTENT_VERSION_KEY)
      .$if(versions.fromVersion !== undefined, (query) =>
        query.where("value_json", "=", String(versions.fromVersion)),
      ),
  );
}
