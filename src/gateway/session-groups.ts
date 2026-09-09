// Gateway-owned custom session group catalog.
// Membership stays on each session entry's category field; this module owns
// which groups exist, their display order, and bulk member category updates.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope.js";
import {
  applySessionEntryReplacements,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  ensureSessionGroupsSchema,
  parseSessionGroupSectionOrder,
  type SessionGroupsDatabase,
} from "../state/openclaw-agent-session-groups-schema.js";
import {
  SessionMutationAuthorizationChangedError,
  type SessionMutationTarget,
} from "./session-mutation-authorization-error.js";

type SessionGroupRecord = {
  name: string;
  position: number;
};

type SessionGroupDefaultsRecord = {
  name: string;
  cwd?: string;
  worktree?: boolean;
};

export class SessionGroupNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown session group: ${name}`);
    this.name = "SessionGroupNotFoundError";
  }
}

export class SessionGroupNotEmptyError extends Error {
  constructor(readonly groups: ReadonlyArray<{ name: string; memberSessions: number }>) {
    super(
      `sessions.groups.put cannot drop groups that still have member sessions: ${groups
        .map((group) => `"${group.name}" (${group.memberSessions})`)
        .join(", ")}; include them in names or remove them via sessions.groups.delete`,
    );
    this.name = "SessionGroupNotEmptyError";
  }
}

const ensuredGroupDatabases = new WeakSet<DatabaseSync>();

function dbFor(agentId: string, env: NodeJS.ProcessEnv): DatabaseSync {
  const database = openOpenClawAgentDatabase({ agentId, env });
  if (!ensuredGroupDatabases.has(database.db)) {
    runOpenClawAgentWriteTransaction(({ db }) => ensureSessionGroupsSchema(db), { agentId, env });
    ensuredGroupDatabases.add(database.db);
  }
  return database.db;
}

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionGroupsDatabase>(db);
}

function readSidebarSectionOrder(db: DatabaseSync): string[] | undefined {
  const row = executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .selectFrom("session_group_state")
      .select("section_order_json")
      .where("singleton", "=", 1),
  ).rows[0];
  return row ? parseSessionGroupSectionOrder(row.section_order_json) : undefined;
}

function updateSidebarSectionOrder(
  db: DatabaseSync,
  update: (current: string[] | undefined) => string[] | undefined,
): void {
  const next = update(readSidebarSectionOrder(db));
  if (!next) {
    return;
  }
  const section_order_json = JSON.stringify(next);
  executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .insertInto("session_group_state")
      .values({ singleton: 1, section_order_json, import_fingerprint: null })
      .onConflict((conflict) => conflict.column("singleton").doUpdateSet({ section_order_json })),
  );
}

export function normalizeGroupNames(names: readonly string[]): string[] {
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

function normalizeSidebarSectionOrder(
  sectionOrder: readonly string[],
  groupNames: readonly string[],
): string[] {
  const groups = new Set(groupNames);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of sectionOrder) {
    const sectionId = raw.trim();
    let canonical: string | null = null;
    if (sectionId === "ungrouped" || sectionId === "groups" || sectionId === "work") {
      canonical = sectionId;
    } else if (sectionId.startsWith("category:")) {
      const name = normalizeOptionalString(sectionId.slice("category:".length));
      if (name && groups.has(name)) {
        canonical = `category:${name}`;
      }
    } else if (sectionId.startsWith("catalog:")) {
      const catalogId = normalizeOptionalString(sectionId.slice("catalog:".length));
      if (catalogId) {
        canonical = `catalog:${catalogId}`;
      }
    }
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

export function listSessionGroups(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupRecord[] {
  const db = dbFor(agentId, env);
  const query = kyselyFor(db)
    .selectFrom("session_groups")
    .select(["name", "position"])
    .orderBy("position", "asc")
    .orderBy("name", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

export function listSessionGroupDefaults(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupDefaultsRecord[] {
  const db = dbFor(agentId, env);
  return executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .selectFrom("session_groups")
      .select(["name", "cwd", "worktree"])
      .orderBy("position", "asc")
      .orderBy("name", "asc"),
  ).rows.map((row) => {
    const group: SessionGroupDefaultsRecord = { name: row.name };
    if (row.cwd) {
      group.cwd = row.cwd;
    }
    if (row.worktree !== null) {
      group.worktree = row.worktree === 1;
    }
    return group;
  });
}

export function listSidebarSectionOrder(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return readSidebarSectionOrder(dbFor(agentId, env)) ?? [];
}

/**
 * Replaces the ordered catalog. Dropping a name whose group still has member
 * sessions is rejected: member sweeps stay owned by sessions.groups.delete,
 * so a put can never leave dangling categories that resurrect the group.
 */
export function putSessionGroups(params: {
  agentId: string;
  cfg: OpenClawConfig;
  names: readonly string[];
  sectionOrder?: readonly string[];
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId?: string; sessionKey: string }) => void;
}): SessionGroupRecord[] {
  const { agentId, cfg, names, sectionOrder, env = process.env } = params;
  const normalized = normalizeGroupNames(names);
  const normalizedSectionOrder =
    sectionOrder === undefined ? undefined : normalizeSidebarSectionOrder(sectionOrder, normalized);
  params.assertCurrent?.();
  const dropped = listSessionGroups(agentId, env).filter(
    (group) => !normalized.includes(group.name),
  );
  if (dropped.length > 0) {
    // Accepted race: sessions.patch can assign a dropped category between this scan and commit.
    // That residue self-heals via ensureSessionGroupRegistered absorption on the next patch.
    const targetsByName = resolveSessionGroupMutationTargetsByName(cfg, agentId, env);
    // Unlike updateMemberCategories, put has not committed any catalog changes yet.
    // Fail closed on changed targets before disclosing any member counts.
    for (const { name } of dropped) {
      for (const target of targetsByName.get(name) ?? []) {
        params.assertTargetCurrent?.({ agentId, sessionKey: target.sessionKey });
      }
    }
    const nonEmpty = dropped
      .map(({ name }) => ({ name, memberSessions: targetsByName.get(name)?.length ?? 0 }))
      .filter((group) => group.memberSessions > 0);
    if (nonEmpty.length > 0) {
      throw new SessionGroupNotEmptyError(nonEmpty);
    }
  }
  const now = Date.now();
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = new Map(
        executeSqliteQuerySync(
          db,
          kysely.selectFrom("session_groups").select(["name", "created_at"]),
        ).rows.map((row) => [row.name, row]),
      );
      executeSqliteQuerySync(
        db,
        normalized.length === 0
          ? kysely.deleteFrom("session_groups")
          : kysely.deleteFrom("session_groups").where("name", "not in", normalized),
      );
      normalized.forEach((name, position) => {
        const prior = existing.get(name);
        executeSqliteQuerySync(
          db,
          prior
            ? kysely.updateTable("session_groups").set({ position }).where("name", "=", name)
            : kysely.insertInto("session_groups").values({
                name,
                position,
                created_at: now,
              }),
        );
      });
      if (normalizedSectionOrder) {
        updateSidebarSectionOrder(db, () => normalizedSectionOrder);
        // `names` remains authoritative for group-only surfaces such as the Sessions page.
        // The sidebar stores the caller's cross-section order without silently deriving it.
      }
    },
    { agentId, env },
  );
  return listSessionGroups(agentId, env);
}

/**
 * Absorbs a category assigned through sessions.patch so the catalog keeps
 * covering every group an operator UI can observe, appended at the end.
 */
export function ensureSessionGroupRegistered(
  name: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    return false;
  }
  dbFor(agentId, env);
  let inserted = false;
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", normalized).limit(1),
      ).rows[0];
      if (existing) {
        return;
      }
      inserted = true;
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
    { agentId, env },
  );
  return inserted;
}

function readCatalogEntry(db: DatabaseSync, name: string) {
  const query = kyselyFor(db).selectFrom("session_groups").where("name", "=", name).limit(1);
  return executeSqliteQuerySync(db, query.selectAll()).rows[0];
}

function prepareCatalogRename(from: string, to: string, agentId: string, env: NodeJS.ProcessEnv) {
  return runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const source = readCatalogEntry(db, from);
      if (!source) {
        throw new SessionGroupNotFoundError(from);
      }
      // Both names must exist while member writes span agent databases. Retain
      // the source until every guarded write succeeds; existing targets keep their defaults.
      if (!readCatalogEntry(db, to)) {
        executeSqliteQuerySync(
          db,
          kyselyFor(db)
            .insertInto("session_groups")
            .values({ ...source, name: to }),
        );
      }
      return source;
    },
    { agentId, env },
  );
}

function retireCatalogEntry(
  from: string,
  to: string | undefined,
  source: ReturnType<typeof readCatalogEntry>,
  agentId: string,
  env: NodeJS.ProcessEnv,
): void {
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      // A successful concurrent defaults edit, reorder, or recreation owns the
      // retained source. Never erase it using a pre-sweep snapshot.
      if (!isDeepStrictEqual(readCatalogEntry(db, from), source)) {
        throw new Error(`session group ${JSON.stringify(from)} changed before completion`);
      }
      if (to !== undefined && !readCatalogEntry(db, to)) {
        throw new SessionGroupNotFoundError(to);
      }
      const sourceSectionId = `category:${from}`;
      const targetSectionId = to === undefined ? undefined : `category:${to}`;
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("session_groups").where("name", "=", from),
      );
      updateSidebarSectionOrder(db, (current) => {
        if (!current?.includes(sourceSectionId)) {
          return undefined;
        }
        // A target slot already owns the merged group's position; retire the source slot.
        return targetSectionId === undefined || current.includes(targetSectionId)
          ? current.filter((sectionId) => sectionId !== sourceSectionId)
          : current.map((sectionId) =>
              sectionId === sourceSectionId ? targetSectionId : sectionId,
            );
      });
    },
    { agentId, env },
  );
}

export function updateSessionGroupDefaults(
  name: string,
  defaults: { cwd: string | null; worktree: boolean },
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupDefaultsRecord[] | null {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    throw new Error("group defaults update requires a non-empty name");
  }
  dbFor(agentId, env);
  let updated = false;
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQuerySync(
        db,
        kysely.selectFrom("session_groups").select("name").where("name", "=", normalized).limit(1),
      ).rows[0];
      if (!existing) {
        return;
      }
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("session_groups")
          .set({
            cwd: normalizeOptionalString(defaults.cwd) ?? null,
            worktree: defaults.worktree ? 1 : 0,
          })
          .where("name", "=", normalized),
      );
      updated = result.numAffectedRows === 1n;
    },
    { agentId, env },
  );
  return updated ? listSessionGroupDefaults(agentId, env) : null;
}

function* sessionGroupStores(cfg: OpenClawConfig, agentId: string, env: NodeJS.ProcessEnv) {
  const visited = new Set<string>();
  for (const target of resolveAgentSessionStoreTargetsSync(cfg, agentId, { env })) {
    const sqliteTarget = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId,
      defaultAgentId: tryResolveLegacyCompatibilityAgentId(cfg),
      env,
    });
    if (visited.has(sqliteTarget.path)) {
      continue;
    }
    visited.add(sqliteTarget.path);
    // An explicit SQLite locator can hold several logical agents in one physical store.
    const entries = listSessionEntriesReadOnly({
      agentId,
      storePath: target.storePath,
      env,
    }).filter(
      ({ sessionKey }) =>
        normalizeAgentId(
          parseAgentSessionKey(sessionKey)?.agentId ?? sqliteTarget.agentId ?? agentId,
        ) === agentId,
    );
    yield { storePath: target.storePath, entries };
  }
}

export function resolveSessionGroupMutationTargetsByName(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, SessionMutationTarget[]> {
  const targetsByName = new Map<string, SessionMutationTarget[]>();
  for (const { entries } of sessionGroupStores(cfg, agentId, env)) {
    for (const { sessionKey, entry } of entries) {
      const groupName = normalizeOptionalString(entry.category);
      if (!groupName) {
        continue;
      }
      const targets = targetsByName.get(groupName) ?? [];
      targets.push({ sessionKey, agentId });
      targetsByName.set(groupName, targets);
    }
  }
  return targetsByName;
}

/**
 * Bulk-updates member session categories in the selected agent without
 * bumping updatedAt: group maintenance must not reshuffle recency ordering.
 */
async function updateMemberCategories(
  cfg: OpenClawConfig,
  agentId: string,
  from: string,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void,
): Promise<number> {
  let updated = 0;
  for (const target of sessionGroupStores(cfg, agentId, env)) {
    const sessionKeys = target.entries
      .filter(({ entry }) => entry.category?.trim() === from)
      .map(({ sessionKey }) => sessionKey);
    if (sessionKeys.length === 0) {
      continue;
    }
    let changedSessionKeys: string[] = [];
    updated += await applySessionEntryReplacements<number>({
      storePath: target.storePath,
      agentId,
      env,
      sessionKeys,
      assertCommitAllowed: () => {
        // The replacement writer awaits planning; recheck the same members at
        // its synchronous commit so a closed caller cannot write stale work.
        for (const sessionKey of changedSessionKeys) {
          assertTargetCurrent?.({ agentId, sessionKey });
        }
        if (to !== undefined && !readCatalogEntry(dbFor(agentId, env), to)) {
          throw new SessionGroupNotFoundError(to);
        }
      },
      update: (entries) => {
        const replacements = entries.flatMap(({ sessionKey, entry }) => {
          if (entry.category?.trim() !== from) {
            return [];
          }
          assertTargetCurrent?.({ agentId, sessionKey });
          const next = { ...entry };
          if (to === undefined) {
            delete next.category;
          } else {
            next.category = to;
          }
          return [{ sessionKey, entry: next }];
        });
        changedSessionKeys = replacements.map(({ sessionKey }) => sessionKey);
        return { replacements, result: replacements.length };
      },
    });
  }
  return updated;
}

type SessionGroupMutationParams = {
  agentId: string;
  cfg: OpenClawConfig;
  name: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
};

async function mutateSessionGroup(
  params: SessionGroupMutationParams & { to?: string },
  action: "rename" | "delete",
): Promise<{ groups: SessionGroupRecord[]; sectionOrder: string[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const agentId = params.agentId;
  const from = normalizeOptionalString(params.name);
  const to = action === "rename" ? normalizeOptionalString(params.to) : undefined;
  if (!from || (action === "rename" && !to)) {
    throw new Error(
      action === "rename"
        ? "group rename requires non-empty names"
        : "group delete requires a non-empty name",
    );
  }
  dbFor(agentId, env);
  let updatedSessions = 0;
  if (from !== to) {
    params.assertCurrent?.();
    const source =
      to === undefined
        ? readCatalogEntry(dbFor(agentId, env), from)
        : prepareCatalogRename(from, to, agentId, env);
    try {
      updatedSessions = await updateMemberCategories(
        params.cfg,
        agentId,
        from,
        to,
        env,
        params.assertTargetCurrent,
      );
      params.assertCurrent?.();
      // A new assignment can enter a store already visited by the sweep.
      // Keep its catalog name instead of stranding that newer member.
      if (resolveSessionGroupMutationTargetsByName(params.cfg, agentId, env).get(from)?.length) {
        throw new Error(`session group ${JSON.stringify(from)} still has members`);
      }
      retireCatalogEntry(from, to, source, agentId, env);
    } catch (error) {
      const message = `${formatErrorMessage(error)}. Group changes may be partial; reload groups and retry the same operation.`;
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw new SessionMutationAuthorizationChangedError({ ...error.error, message });
      }
      throw new Error(message, { cause: error });
    }
  }
  return {
    groups: listSessionGroups(agentId, env),
    sectionOrder: listSidebarSectionOrder(agentId, env),
    updatedSessions,
  };
}

export async function renameSessionGroup(params: SessionGroupMutationParams & { to: string }) {
  return await mutateSessionGroup(params, "rename");
}

export async function deleteSessionGroup(params: SessionGroupMutationParams) {
  return await mutateSessionGroup(params, "delete");
}
