import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { ensureColumn, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  SessionGroupCatalogMutation,
  SessionGroupCatalogMutationResult,
  SessionGroupCatalogSnapshot,
  SessionGroupDefaultsRecord,
} from "./session-group-catalog.types.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { registerSessionGroupInDatabase } from "./session-group-registration.kernel.js";
import type { SessionMutationTarget } from "./session-mutation-authorization-error.js";

const SIDEBAR_ORDER = "sidebar.sectionOrder";
const defaultsDatabases = new WeakSet<DatabaseSync>();
const kyselyFor = (db: DatabaseSync) =>
  getNodeSqliteKysely<Pick<DB, "session_groups" | "config_machine_state">>(db);

function hasDefaults(db: DatabaseSync): boolean {
  return (
    tableHasColumn(db, "session_groups", "cwd") && tableHasColumn(db, "session_groups", "worktree")
  );
}

export function readSessionGroupCatalogEntry(db: DatabaseSync, name: string) {
  const query = kyselyFor(db).selectFrom("session_groups").where("name", "=", name).limit(1);
  const row = executeSqliteQuerySync(
    db,
    hasDefaults(db) ? query.selectAll() : query.select(["name", "position", "created_at"]),
  ).rows[0];
  // The captured source crosses a worker message, which normalizes SQLite's row prototype.
  return row && { ...row };
}

export function readSessionGroupCatalogSnapshot(db: DatabaseSync): SessionGroupCatalogSnapshot {
  const query = kyselyFor(db).selectFrom("session_groups").orderBy("position").orderBy("name");
  const defaultsSchema = hasDefaults(db);
  const groups = executeSqliteQuerySync(db, query.select(["name", "position"])).rows;
  const defaults = defaultsSchema
    ? executeSqliteQuerySync(db, query.select(["name", "cwd", "worktree"])).rows.map((row) => {
        const record: SessionGroupDefaultsRecord = { name: row.name };
        if (row.cwd) {
          record.cwd = row.cwd;
        }
        if (row.worktree !== null) {
          record.worktree = row.worktree === 1;
        }
        return record;
      })
    : groups.map(({ name }) => ({ name }));
  const order = readConfigMachineStateRowInDatabase(db, SIDEBAR_ORDER);
  // SAFETY: The sidebar owner and v12 migration store this key only as a string array.
  const sectionOrder = order ? (JSON.parse(order.value_json) as string[]) : [];
  return { groups, defaults, sectionOrder };
}

function updateSidebarOrder(
  db: DatabaseSync,
  update: (current: string[] | undefined) => string[] | undefined,
) {
  const row = readConfigMachineStateRowInDatabase(db, SIDEBAR_ORDER);
  // SAFETY: The sidebar owner and v12 migration store this key only as a string array.
  const next = update(row ? (JSON.parse(row.value_json) as string[]) : undefined);
  if (!next) {
    return;
  }
  const values = { value_json: JSON.stringify(next), updated_at_ms: Date.now() };
  executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .insertInto("config_machine_state")
      .values({ state_key: SIDEBAR_ORDER, ...values })
      .onConflict((conflict) => conflict.column("state_key").doUpdateSet(values)),
  );
}

export function mutateSessionGroupCatalogInDatabase(
  database: OpenClawStateDatabase,
  input: SessionGroupCatalogMutation,
  env: NodeJS.ProcessEnv,
): SessionGroupCatalogMutationResult {
  if (input.kind === "register") {
    const changed = registerSessionGroupInDatabase(database, input.name, env);
    return { changed, snapshot: readSessionGroupCatalogSnapshot(database.db) };
  }
  let ensuredDefaults = false;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const names = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").orderBy("position").orderBy("name"),
      ).rows.map((row) => row.name);
      const selected =
        input.kind === "put"
          ? names.filter((name) => !input.names.includes(name))
          : input.kind === "defaults" || input.kind === "retire"
            ? [input.name]
            : [];
      const readGroups = () => {
        if (!("cfg" in input) || selected.length === 0) {
          return undefined;
        }
        const members = new Map(readSessionGroupMembership(input.cfg, env).groups);
        return selected.map((name): [string, SessionMutationTarget[]] => [
          name,
          members.get(name) ?? [],
        ]);
      };
      const groups = readGroups();
      const assertGroupsCurrent = () => {
        if (groups && !isDeepStrictEqual(groups, readGroups())) {
          throw new Error(
            "Session group members changed before catalog mutation; retry the request",
          );
        }
      };
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { names, groups },
      });
      assertGroupsCurrent();
      let changed = false;
      let source: SessionGroupCatalogMutationResult["source"];
      let missingName: string | undefined;
      if (input.kind === "put") {
        const nonEmpty = groups
          ?.map(([name, members]) => ({ name, memberSessions: members.length }))
          .filter((group) => group.memberSessions > 0);
        if (nonEmpty?.length) {
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          assertGroupsCurrent();
          return { changed: false, nonEmpty, snapshot: readSessionGroupCatalogSnapshot(db) };
        }
        const now = Date.now();
        const existing = new Set(names);
        executeSqliteQuerySync(
          db,
          input.names.length === 0
            ? kysely.deleteFrom("session_groups")
            : kysely.deleteFrom("session_groups").where("name", "not in", input.names),
        );
        input.names.forEach((name, position) =>
          executeSqliteQuerySync(
            db,
            existing.has(name)
              ? kysely.updateTable("session_groups").set({ position }).where("name", "=", name)
              : kysely.insertInto("session_groups").values({ name, position, created_at: now }),
          ),
        );
        if (input.sectionOrder) {
          updateSidebarOrder(db, () => input.sectionOrder);
        }
        changed = true;
      } else if (input.kind === "defaults") {
        if (readSessionGroupCatalogEntry(db, input.name)) {
          if (!defaultsDatabases.has(db)) {
            ensureColumn(db, "session_groups", "cwd TEXT");
            ensureColumn(db, "session_groups", "worktree INTEGER");
            ensuredDefaults = true;
          }
          changed =
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("session_groups")
                .set({ cwd: input.cwd, worktree: input.worktree ? 1 : 0 })
                .where("name", "=", input.name),
            ).numAffectedRows === 1n;
        }
      } else if (input.kind === "prepare") {
        source = readSessionGroupCatalogEntry(db, input.name);
        if (input.to && !source) {
          missingName = input.name;
        } else if (input.to && source && !readSessionGroupCatalogEntry(db, input.to)) {
          executeSqliteQuerySync(
            db,
            kysely.insertInto("session_groups").values({ ...source, name: input.to }),
          );
          changed = true;
        }
      } else {
        if (groups?.some(([, members]) => members.length > 0)) {
          throw new Error(`session group ${JSON.stringify(input.name)} still has members`);
        }
        if (!isDeepStrictEqual(readSessionGroupCatalogEntry(db, input.name), input.source)) {
          throw new Error(`session group ${JSON.stringify(input.name)} changed before completion`);
        }
        if (input.to !== undefined && !readSessionGroupCatalogEntry(db, input.to)) {
          missingName = input.to;
        } else {
          executeSqliteQuerySync(
            db,
            kysely.deleteFrom("session_groups").where("name", "=", input.name),
          );
          const from = `category:${input.name}`;
          const to = input.to === undefined ? undefined : `category:${input.to}`;
          updateSidebarOrder(db, (current) =>
            !current?.includes(from)
              ? undefined
              : to === undefined || current.includes(to)
                ? current.filter((id) => id !== from)
                : current.map((id) => (id === from ? to : id)),
          );
          changed = true;
        }
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      assertGroupsCurrent();
      return { changed, source, missingName, snapshot: readSessionGroupCatalogSnapshot(db) };
    },
    { database, path: database.path, env },
  );
  if (ensuredDefaults) {
    defaultsDatabases.add(database.db);
  }
  return result;
}
