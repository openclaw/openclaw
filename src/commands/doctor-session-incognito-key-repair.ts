import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Compilable } from "kysely";
import { listSessionEntryKeysReadOnly } from "../config/sessions/session-accessor.js";
import { publishSessionEntryCacheInvalidation } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  attachSessionEntrySnapshots,
  sessionEntrySnapshotColumns,
} from "../config/sessions/session-entry-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import {
  listExistingAgentDatabaseTargets,
  resolveTargetSqliteOptions,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  type OpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import {
  collectSharedStateSessionKeys,
  deleteRepairJournal,
  readRepairJournal,
  readRepairJournalReadOnly,
  rewriteSharedStateSessionKeys,
  type ReservedKeyRename,
  writeRepairJournal,
} from "./doctor-session-incognito-key-repair-state.js";
import { rewriteDoctorSessionEntries } from "./doctor/shared/session-entry-rewrite.js";

export type ReservedIncognitoKeyRepairReport = {
  found: number;
  repaired: number;
};

export async function repairReservedIncognitoSessionKeys(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
}): Promise<ReservedIncognitoKeyRepairReport> {
  const targets = (params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env)).map(
    (target) => ({
      target,
      databaseOptions: resolveTargetSqliteOptions(target, params.env),
    }),
  );
  const reservedKeys = new Set<string>();
  const sharedDatabase = params.apply ? openOpenClawStateDatabase({ env: params.env }) : undefined;
  const journalRenames = sharedDatabase
    ? readRepairJournal(sharedDatabase.db)
    : readRepairJournalReadOnly(params.env);
  const collectAgentKeys = (
    keys: Set<string>,
    read: (database: DatabaseSync) => Iterable<string>,
  ) => {
    for (const { target, databaseOptions } of targets) {
      const operation = runDoctorAgentDatabaseOperation({
        agentId: target.agentId,
        path: target.sqlitePath,
        run: () =>
          withOpenClawAgentDatabaseReadOnly((database) => read(database.db), databaseOptions),
      });
      if (operation.ok && operation.value.found) {
        for (const key of operation.value.value) {
          keys.add(key);
        }
      }
    }
  };
  collectAgentKeys(reservedKeys, listReservedIncognitoKeys);
  const pendingKeys = new Set(reservedKeys);
  for (const rename of journalRenames) {
    pendingKeys.add(rename.from);
  }
  if (!params.apply) {
    return { found: pendingKeys.size, repaired: 0 };
  }
  if (reservedKeys.size === 0 && journalRenames.length === 0) {
    return { found: 0, repaired: 0 };
  }

  const occupiedKeys = sharedDatabase
    ? collectSharedStateSessionKeys(sharedDatabase.db)
    : new Set<string>();
  collectAgentKeys(occupiedKeys, collectOccupiedSessionKeys);
  for (const rename of journalRenames) {
    occupiedKeys.add(rename.to);
  }
  const journalSources = new Set(journalRenames.map((rename) => rename.from));
  const newRenames = planReservedIncognitoKeyRenames(
    [...reservedKeys].filter((key) => !journalSources.has(key)).toSorted(),
    occupiedKeys,
  );
  const renames = [...journalRenames, ...newRenames];
  const renameMap = new Map(renames.map((item) => [item.from, item.to]));
  runOpenClawStateWriteTransaction(
    (database) => writeRepairJournal(database.db, renames),
    { env: params.env },
    { operationLabel: "doctor.journal-reserved-incognito-session-keys" },
  );
  runOpenClawStateWriteTransaction(
    (database) => rewriteSharedStateSessionKeys(database.db, renameMap),
    { env: params.env },
    { operationLabel: "doctor.rename-reserved-incognito-shared-state-keys" },
  );
  for (const { target, databaseOptions } of targets) {
    const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
    try {
      runOpenClawAgentWriteTransaction(
        (database) => applyReservedIncognitoKeyRenameColumns(database, renames),
        databaseOptions,
        { operationLabel: "doctor.rename-reserved-incognito-session-keys" },
      );
      rewriteDoctorSessionEntries({
        scope: { agentId: target.agentId, env: params.env, storePath: target.storePath },
        sessionKeys: await listSessionEntryKeysReadOnly({
          agentId: target.agentId,
          env: params.env,
          storePath: target.storePath,
        }),
        transform: (entry) => rewriteSessionEntryKeyFields(entry, renameMap),
      });
    } finally {
      if (!wasOpen) {
        closeOpenClawAgentDatabaseByPath(target.sqlitePath);
      }
    }
  }
  runOpenClawStateWriteTransaction(
    (database) => deleteRepairJournal(database.db),
    { env: params.env },
    { operationLabel: "doctor.complete-reserved-incognito-session-keys" },
  );
  return { found: pendingKeys.size, repaired: renames.length };
}

function planReservedIncognitoKeyRenames(
  keys: readonly string[],
  occupied: Set<string>,
): ReservedKeyRename[] {
  return keys.map((key) => {
    const base = legacyIncognitoSessionKey(key);
    const internalEffectsKey = parseAgentSessionKey(key)?.rest.startsWith(
      "internal-session-effects:",
    );
    if (internalEffectsKey && occupied.has(base)) {
      throw new Error(`Cannot repair internal session key because ${base} already exists`);
    }
    let candidate = base;
    let suffix = 1;
    while (occupied.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    occupied.add(candidate);
    return { from: key, to: candidate };
  });
}

function applyReservedIncognitoKeyRenameColumns(
  database: OpenClawAgentDatabase,
  renames: readonly ReservedKeyRename[],
): void {
  if (renames.length === 0) {
    return;
  }
  // Board widget foreign keys are immediate; defer them so every key-bearing row renames atomically.
  database.db.exec("PRAGMA defer_foreign_keys = ON;"); // sqlite-allow-raw -- transaction-local FK deferral.
  for (const rename of renames) {
    const affected = executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
        .selectFrom("session_nodes")
        .select("session_key")
        .where((eb) =>
          eb.or([
            eb("session_key", "=", rename.from),
            eb("parent_session_key", "=", rename.from),
            eb("spawned_by", "=", rename.from),
            eb("fork_source_session_key", "=", rename.from),
          ]),
        ),
    ).rows;
    updateSessionKeyColumns(database.db, rename);
    for (const sessionKey of new Set([rename.to, ...affected.map((row) => row.session_key)])) {
      publishSessionEntryCacheInvalidation(database, { sessionKey });
    }
  }
}

function legacyIncognitoSessionKey(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || !isIncognitoSessionKey(sessionKey)) {
    throw new Error(`Cannot rename non-incognito session key: ${sessionKey}`);
  }
  return `agent:${parsed.agentId}:${parsed.rest.replace(":incognito-", ":legacy-incognito-")}`;
}

function listReservedIncognitoKeys(database: DatabaseSync): string[] {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const keys = new Set<string>();
  for (const table of ["session_nodes", "session_windows"] as const) {
    for (const row of executeSqliteQuerySync(database, db.selectFrom(table).select("session_key"))
      .rows) {
      keys.add(row.session_key);
    }
  }
  return [...keys].filter(isIncognitoSessionKey).toSorted();
}

function collectOccupiedSessionKeys(database: DatabaseSync): Set<string> {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  const keys = new Set<string>();
  const collectColumns = (query: Compilable<Record<string, string | null>>) => {
    for (const row of executeSqliteQuerySync(database, query).rows) {
      for (const value of Object.values(row)) {
        if (value) {
          keys.add(value);
        }
      }
    }
  };
  collectColumns(
    db.selectFrom("session_windows").select(["session_key", "parent_session_key", "spawned_by"]),
  );
  collectColumns(
    db
      .selectFrom("session_nodes")
      .select(["session_key", "parent_session_key", "spawned_by", "fork_source_session_key"]),
  );
  collectColumns(db.selectFrom("conversation_deliveries").select("source_session_key"));
  for (const row of iterateSqliteQuerySync(
    database,
    db.selectFrom("session_nodes").select("entry_json").select(sessionEntrySnapshotColumns),
  )) {
    try {
      const entry: unknown = JSON.parse(row.entry_json);
      if (isRecord(entry)) {
        collectSessionEntryKeyFields(attachSessionEntrySnapshots(entry, row), keys);
      }
    } catch {
      // Canonical rows are valid JSON; a malformed row is reported by the existing integrity pass.
    }
  }
  collectColumns(db.selectFrom("board_tabs").select("session_key"));
  collectColumns(db.selectFrom("board_widgets").select("session_key"));
  collectColumns(db.selectFrom("heartbeat_outcomes").select(["session_key", "run_session_key"]));
  return keys;
}

function updateSessionKeyColumns(database: DatabaseSync, rename: ReservedKeyRename): void {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database);
  for (const [table, column] of [
    ["session_windows", "session_key"],
    ["session_windows", "parent_session_key"],
    ["session_windows", "spawned_by"],
    ["session_nodes", "session_key"],
    ["session_entry_snapshots", "session_key"],
    ["session_nodes", "parent_session_key"],
    ["session_nodes", "spawned_by"],
    ["session_nodes", "fork_source_session_key"],
    ["conversation_deliveries", "source_session_key"],
    ["session_members", "session_key"],
    ["board_tabs", "session_key"],
    ["board_widgets", "session_key"],
    ["heartbeat_outcomes", "session_key"],
    ["heartbeat_outcomes", "run_session_key"],
  ] as const) {
    executeSqliteQuerySync(
      database,
      db.updateTable(table).set(column, rename.to).where(column, "=", rename.from),
    );
  }
}

function rewriteSessionEntryKeyFields<T>(value: T, renames: ReadonlyMap<string, string>): T {
  visitSessionEntryKeyFields(value, (record, key) => {
    const current = record[key];
    if (typeof current === "string") {
      record[key] = renames.get(current) ?? current;
    }
  });
  return value;
}

function collectSessionEntryKeyFields(value: unknown, keys: Set<string>): void {
  visitSessionEntryKeyFields(value, (record, key) => {
    const current = record[key];
    if (typeof current === "string") {
      keys.add(current);
    }
  });
}

function visitSessionEntryKeyFields(
  value: unknown,
  visit: (record: Record<string, unknown>, key: string) => void,
): void {
  if (!isRecord(value)) {
    return;
  }
  for (const key of [
    "heartbeatIsolatedBaseSessionKey",
    "spawnedBy",
    "completionOwnerSessionKey",
    "parentSessionKey",
  ]) {
    visit(value, key);
  }
  if (isRecord(value.forkSource)) {
    visit(value.forkSource, "sessionKey");
  }
  if (Array.isArray(value.compactionCheckpoints)) {
    for (const checkpoint of value.compactionCheckpoints) {
      if (isRecord(checkpoint)) {
        visit(checkpoint, "sessionKey");
      }
    }
  }
  if (isRecord(value.systemPromptReport)) {
    visit(value.systemPromptReport, "sessionKey");
  }
}
