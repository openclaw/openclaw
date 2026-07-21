// Gateway-owned custom session group catalog.
// Membership stays on each session entry's category field; this module owns
// which groups exist, their display order, and bulk member category updates.
import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

// Write transactions must run on the same env-scoped handle as their
// statements; a bare transaction would open the default state DB while the
// SQL hits the override, losing atomicity under OPENCLAW_STATE_DIR overrides.

type SessionGroupRecord = { name: string; position: number };

type SessionGroupsDatabase = Pick<OpenClawStateKyselyDatabase, "session_groups">;

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionGroupsDatabase>(db);
}

function normalizeGroupNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    const name = normalizeOptionalString(raw);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

export function listSessionGroups(env: NodeJS.ProcessEnv = process.env): SessionGroupRecord[] {
  const db = dbFor(env);
  const query = kyselyFor(db)
    .selectFrom("session_groups")
    .select(["name", "position"])
    .orderBy("position", "asc")
    .orderBy("name", "asc");
  return executeSqliteQuerySync(db, query).rows.map((row) => ({
    name: row.name,
    position: row.position,
  }));
}

/**
 * Merges the ordered catalog. Existing rows keep their created_at; rows in the
 * input get their position updated, and new rows are inserted. Rows not in the
 * input are left untouched so concurrent adds from other clients are preserved.
 */
export function putSessionGroups(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupRecord[] {
  const normalized = normalizeGroupNames(names);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = new Map(
        executeSqliteQuerySync(
          db,
          kysely.selectFrom("session_groups").select(["name", "created_at"]),
        ).rows.map((row) => [row.name, row.created_at]),
      );
      normalized.forEach((name, position) => {
        if (existing.has(name)) {
          executeSqliteQuerySync(
            db,
            kysely.updateTable("session_groups").set({ position }).where("name", "=", name),
          );
          return;
        }
        executeSqliteQuerySync(
          db,
          kysely.insertInto("session_groups").values({
            name,
            position,
            created_at: now,
          }),
        );
      });
    },
    { env },
  );
  return normalized.map((name, position) => ({ name, position }));
}

/** Adds one group to the catalog, appended at the end. Idempotent for existing names. */
export function addSessionGroup(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupRecord {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    throw new Error("group add requires a non-empty name");
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_groups")
          .select(["name", "position"])
          .where("name", "=", normalized)
          .limit(1),
      ).rows[0];
      if (existing) {
        return { name: existing.name, position: existing.position };
      }
      const maxRow = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("position").orderBy("position", "desc").limit(1),
      ).rows[0];
      const position = (maxRow?.position ?? -1) + 1;
      const created_at = Date.now();
      executeSqliteQuerySync(
        db,
        kysely.insertInto("session_groups").values({
          name: normalized,
          position,
          created_at,
        }),
      );
      return { name: normalized, position };
    },
    { env },
  );
}

/**
 * Reorders the listed groups by their input position. Groups not in the input
 * keep their current position and are not inserted or deleted.
 */
export function reorderSessionGroups(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupRecord[] {
  const normalized = normalizeGroupNames(names);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      normalized.forEach((name, position) => {
        executeSqliteQuerySync(
          db,
          kysely.updateTable("session_groups").set({ position }).where("name", "=", name),
        );
      });
    },
    { env },
  );
  return listSessionGroups(env);
}

/**
 * Absorbs a category assigned through sessions.patch so the catalog keeps
 * covering every group an operator UI can observe, appended at the end.
 */
export function ensureSessionGroupRegistered(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", normalized).limit(1),
      ).rows[0];
      if (existing) {
        return;
      }
      const maxRow = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("position").orderBy("position", "desc").limit(1),
      ).rows[0];
      executeSqliteQuerySync(
        db,
        kysely.insertInto("session_groups").values({
          name: normalized,
          position: (maxRow?.position ?? -1) + 1,
          created_at: Date.now(),
        }),
      );
    },
    { env },
  );
}

function renameCatalogEntry(from: string, to: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const source = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").selectAll().where("name", "=", from).limit(1),
      ).rows[0];
      const targetExists = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", to).limit(1),
      ).rows[0];
      executeSqliteQuerySync(db, kysely.deleteFrom("session_groups").where("name", "=", from));
      if (targetExists) {
        // Rename into an existing group merges memberships; keep the target row.
        return;
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("session_groups").values({
          name: to,
          position: source?.position ?? 0,
          created_at: source?.created_at ?? Date.now(),
        }),
      );
    },
    { env },
  );
}

/**
 * Bulk-updates member session categories across every agent store without
 * bumping updatedAt: group maintenance must not reshuffle recency ordering.
 */
async function updateMemberCategories(
  cfg: OpenClawConfig,
  from: string,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let updated = 0;
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
    updated += await applySessionEntryReplacements<number>({
      storePath: target.storePath,
      update: (entries) => {
        const replacements = entries.flatMap(({ sessionKey, entry }) => {
          if (entry.category?.trim() !== from) {
            return [];
          }
          const next = { ...entry };
          if (to === undefined) {
            delete next.category;
          } else {
            next.category = to;
          }
          return [{ sessionKey, entry: next }];
        });
        return { replacements, result: replacements.length };
      },
    });
  }
  return updated;
}

export async function renameSessionGroup(params: {
  cfg: OpenClawConfig;
  name: string;
  to: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ groups: SessionGroupRecord[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const from = normalizeOptionalString(params.name);
  const to = normalizeOptionalString(params.to);
  if (!from || !to) {
    throw new Error("group rename requires non-empty names");
  }
  if (from !== to) {
    renameCatalogEntry(from, to, env);
  }
  const updatedSessions = from === to ? 0 : await updateMemberCategories(params.cfg, from, to, env);
  return { groups: listSessionGroups(env), updatedSessions };
}

export async function deleteSessionGroup(params: {
  cfg: OpenClawConfig;
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ groups: SessionGroupRecord[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const name = normalizeOptionalString(params.name);
  if (!name) {
    throw new Error("group delete requires a non-empty name");
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("session_groups").where("name", "=", name),
      );
    },
    { env },
  );
  const updatedSessions = await updateMemberCategories(params.cfg, name, undefined, env);
  return { groups: listSessionGroups(env), updatedSessions };
}
