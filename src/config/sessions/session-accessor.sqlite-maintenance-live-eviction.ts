// Live-node capacity eviction for the SQLite session disk budget.
// Extracted from session-accessor.sqlite-maintenance.ts to stay within max-lines.

import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import {
  collectActiveSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import { measureSessionPhysicalDiskUsage, type SessionPhysicalDiskUsage } from "./disk-budget.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { readSessionEntryStore } from "./session-accessor.sqlite-entry-inventory.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionEntryMaintenancePlan,
  SessionEntryMaintenanceResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { readSessionMaintenanceKeyProjection } from "./session-accessor.sqlite-maintenance-candidates.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson as parseSessionEntryRow,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveSessionMaintenancePreserveKeys } from "./store-maintenance-preserve-snapshot.js";
import { captureSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import { isRecentSessionMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/**
 * True when the session key identifies a durable human conversation surface
 * (thread, channel, group, Telegram topic) — the only live nodes the disk
 * budget may destructively reclaim as a last resort.
 */
function isDurableConversationSessionKey(
  sessionKey: string,
  entry: SessionEntry | undefined,
): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  if (parseThreadSessionSuffix(sessionKey).threadId) {
    return true;
  }
  if (
    /^[^:]+:(?:group|channel):.+$/.test(rest) ||
    /^telegram:(?:direct|dm):.+:topic:[^:]+$/.test(rest)
  ) {
    return true;
  }
  const chatType = normalizeLowercaseStringOrEmpty(
    entry?.chatType ?? sessionDeliveryOrigin(entry)?.chatType,
  );
  return chatType === "group" || chatType === "channel" || chatType === "thread";
}

const LIVE_VICTIM_PAGE_SIZE = 64;

function emptyLiveEntryPlan(): SessionEntryMaintenancePlan {
  return {
    archivedSessionKeys: [],
    entryRemovals: [],
    stateDeletePlans: [],
    archived: 0,
    capArchived: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
}

/** Activity order matches `getSessionMaintenanceActivityAt` without loading prompt payloads. */
function liveNodeActivityAtSql() {
  return sql<number>`CASE WHEN json_valid(entry_json) THEN MAX(
    COALESCE(json_extract(entry_json, '$.lastInteractionAt'), 0),
    COALESCE(json_extract(entry_json, '$.lastActivityAt'), 0),
    COALESCE(json_extract(entry_json, '$.sessionStartedAt'), 0),
    "updated_at"
  ) ELSE "updated_at" END`;
}

function isLocalEvictionFenceIdentity(identity: string, unprotect: ReadonlySet<string>): boolean {
  const trimmed = identity.trim();
  return (
    trimmed.length > 0 &&
    (unprotect.has(trimmed) || unprotect.has(normalizeStoreSessionKey(trimmed)))
  );
}

/** Session ids owned by in-flight work admissions, without live-reference protection. */
export function collectAdmissionProtectedSessionIds(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = new Set<string>();
  const admissionIdentities =
    collectActiveSessionWorkAdmissions().get(params.storePath) ?? new Set<string>();
  if (admissionIdentities.size === 0) {
    return protectedSessionIds;
  }

  // Admissions may carry either the backing session id or its live session key. Protect both,
  // then resolve admitted keys through their entries so cleanup cannot reclaim active work.
  for (const identity of admissionIdentities) {
    protectedSessionIds.add(identity);
  }
  const normalizedAdmissionKeys = new Set(
    [...admissionIdentities].map((identity) => normalizeStoreSessionKey(identity)),
  );
  const db = getSessionKysely(params.database.db);
  const admittedKeyBytes: string[] = [];
  // Normalize lightweight keys before reading payloads; unrelated saved prompts can be large.
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", db.fn<string>("hex", ["session_key"]).as("key_bytes")]),
  )) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      admittedKeyBytes.push(row.key_bytes);
    }
  }
  const rows = admittedKeyBytes.length
    ? iterateSqliteQuerySync(
        params.database.db,
        db
          .selectFrom("session_nodes")
          .select(["entry_json", "current_session_id"])
          // Keep stored keys inside SQLite: Node TEXT rebinding can change raw UTF-16 keys.
          .where(
            "session_key",
            "in",
            db
              .selectFrom("session_nodes")
              .select("session_key")
              .where(
                db.fn<string>("hex", ["session_key"]),
                "in",
                sqliteStringSet(admittedKeyBytes),
              ),
          ),
      )
    : [];
  for (const row of rows) {
    protectedSessionIds.add(row.current_session_id);
    const entry = parseSessionEntryRow(row);
    if (entry) {
      for (const sessionId of collectSessionStateIdsForEntry(entry)) {
        protectedSessionIds.add(sessionId);
      }
    }
  }
  // Key-scoped admissions must survive rollover: an in-flight run admitted by
  // key may still write to a generation the entry no longer references, so
  // every generation of an admitted key stays off-limits.
  const generationRows = iterateSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  );
  for (const row of generationRows) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      protectedSessionIds.add(row.session_id);
    }
  }
  return protectedSessionIds;
}

function collectAdmissionProtectedStoreKeys(params: {
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = collectAdmissionProtectedSessionIds(params);
  if (protectedSessionIds.size === 0) {
    return new Set();
  }
  const keys = new Set<string>();
  const db = getSessionKysely(params.database.db);
  for (const row of executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_nodes").select(["current_session_id", "session_key"]),
  ).rows) {
    if (
      protectedSessionIds.has(row.session_key) ||
      protectedSessionIds.has(row.current_session_id)
    ) {
      keys.add(row.session_key);
    }
  }
  for (const row of executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  ).rows) {
    if (protectedSessionIds.has(row.session_id)) {
      keys.add(row.session_key);
    }
  }
  return keys;
}

function collectCapacityEligibleLivePreserveKeys(params: {
  baseKeys?: Iterable<string | undefined>;
  database: OpenClawAgentDatabase;
  skipSessionKeys?: ReadonlySet<string>;
  store: Record<string, SessionEntry>;
  storePath: string;
  unprotectSessionKeys?: ReadonlySet<string>;
}): Set<string> {
  const snapshot = captureSessionMaintenancePreservation(params.storePath);
  const unprotect = params.unprotectSessionKeys ?? new Set<string>();
  // Drop only this eviction's lifecycle identities. A provider that starts
  // protecting the victim while the fence is waited for must still veto deletion.
  const preserveKeys = resolveSessionMaintenancePreserveKeys({
    baseKeys: params.baseKeys,
    snapshot: {
      ...snapshot,
      lifecycleIdentities: snapshot.lifecycleIdentities.filter(
        (identity) => !isLocalEvictionFenceIdentity(identity, unprotect),
      ),
    },
    store: params.store,
  });
  for (const key of params.skipSessionKeys ?? []) {
    preserveKeys.add(key);
  }
  for (const key of collectAdmissionProtectedStoreKeys({
    database: params.database,
    storePath: params.storePath,
  })) {
    preserveKeys.add(key);
  }
  return preserveKeys;
}

function planSqliteLiveEntryRemovals(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  projectedStore: Record<string, SessionEntry>;
  removedEntriesByKey: Map<string, SessionEntry>;
  removedKeys: Set<string>;
}): SessionEntryMaintenancePlan {
  const removedSessionIds = new Set<string>();
  for (const entry of params.removedEntriesByKey.values()) {
    for (const sessionId of collectSessionStateIdsForEntry(entry)) {
      removedSessionIds.add(sessionId);
    }
  }
  for (const sessionId of readSessionGenerationIdsForKeys(params.database, [
    ...params.removedKeys,
  ])) {
    removedSessionIds.add(sessionId);
  }
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database: params.database,
    excludedSessionKeys: [...params.removedKeys],
    projectedStore: params.projectedStore,
  });
  const deletePlans: SessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveTranscript: true,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return {
    archivedSessionKeys: [],
    entryRemovals: [...params.removedEntriesByKey].map(([sessionKey, entry]) => ({
      expectedEntry: entry,
      sessionKey,
    })),
    stateDeletePlans: deletePlans,
    archived: 0,
    capArchived: 0,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
}

function resolveLivePreserveRecentMs(preserveRecentMs?: number | null): number | null {
  return preserveRecentMs === undefined
    ? (resolveMaintenanceConfig().preserveRecentMs ?? null)
    : preserveRecentMs;
}

function isCapacityEligibleLiveNode(params: {
  entry: SessionEntry;
  key: string;
  preserveKeys: ReadonlySet<string>;
  preserveRecentMs: number | null;
  skipSessionKeys?: ReadonlySet<string>;
}): boolean {
  const { entry, key } = params;
  if (params.skipSessionKeys?.has(key)) {
    return false;
  }
  if (entry.archivedAt !== undefined || entry.pinnedAt !== undefined) {
    return false;
  }
  if (entry.modelSelectionLocked === true || entry.status === "running") {
    return false;
  }
  if (params.preserveKeys.has(key) || params.preserveKeys.has(normalizeStoreSessionKey(key))) {
    return false;
  }
  const parsed = parseAgentSessionKey(key);
  if (parsed?.rest === "main" || key === "global") {
    return false;
  }
  if (isRecentSessionMaintenanceEntry({ key, entry, preserveRecentMs: params.preserveRecentMs })) {
    return false;
  }
  // Only durable conversation surfaces (threads, channels, groups, topics)
  // are eligible. Ordinary session entries are not destructively reclaimable.
  return isDurableConversationSessionKey(key, entry);
}

/** Oldest eligible live node, paging metadata instead of the full catalog. */
function readOldestCapacityEligibleLiveNode(params: {
  database: OpenClawAgentDatabase;
  preserveKeys: ReadonlySet<string>;
  preserveRecentMs: number | null;
  skipSessionKeys?: ReadonlySet<string>;
}): { entry: SessionEntry; key: string } | undefined {
  const db = getSessionKysely(params.database.db);
  // Alias the activity expression so the page cursor can filter it. SQLite
  // does not allow that alias in the same SELECT's WHERE.
  const candidates = db
    .selectFrom("session_nodes")
    .select(["session_key", sessionEntryMetadataJson, liveNodeActivityAtSql().as("activity_at")])
    .where("archived_at", "is", null)
    .as("live_candidates");
  let cursor: { activityAt: number; sessionKey: string } | undefined;
  for (;;) {
    let query = db
      .selectFrom(candidates)
      .selectAll()
      .orderBy("activity_at", "asc")
      .orderBy("session_key", "asc")
      .limit(LIVE_VICTIM_PAGE_SIZE);
    if (cursor) {
      const after = cursor;
      query = query.where((eb) =>
        eb.or([
          eb("activity_at", ">", after.activityAt),
          eb.and([
            eb("activity_at", "=", after.activityAt),
            eb("session_key", ">", after.sessionKey),
          ]),
        ]),
      );
    }
    const rows = executeSqliteQuerySync(params.database.db, query).rows;
    for (const row of rows) {
      const activity = Number(row.activity_at);
      cursor = {
        activityAt: Number.isFinite(activity) ? activity : 0,
        sessionKey: row.session_key,
      };
      const preview = parseSessionEntryRow(row);
      if (
        !preview ||
        !isCapacityEligibleLiveNode({
          entry: preview,
          key: row.session_key,
          preserveKeys: params.preserveKeys,
          preserveRecentMs: params.preserveRecentMs,
          skipSessionKeys: params.skipSessionKeys,
        })
      ) {
        continue;
      }
      const entry = readSessionEntryStore(params.database, { sessionKeys: [row.session_key] })[
        row.session_key
      ];
      if (
        entry &&
        isCapacityEligibleLiveNode({
          entry,
          key: row.session_key,
          preserveKeys: params.preserveKeys,
          preserveRecentMs: params.preserveRecentMs,
          skipSessionKeys: params.skipSessionKeys,
        })
      ) {
        return { entry, key: row.session_key };
      }
    }
    if (rows.length < LIVE_VICTIM_PAGE_SIZE) {
      return undefined;
    }
  }
}

/** Plans at most one oldest capacity-eligible live session_node removal.
 *
 * This is the last-resort disk-budget tier. `capEntryCount` archives ordinary
 * sessions instead of deleting them, so this function bypasses the cap path
 * entirely and directly selects the oldest idle live node for deletion.
 * Always-protected entries (primary, pinned, model-locked, active/admitted,
 * recently active) are never victims.
 */
export function planOldestCapacityEligibleSqliteLiveEntryRemoval(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  skipSessionKeys?: ReadonlySet<string>;
  storePath: string;
  preserveRecentMs?: number | null;
  unprotectSessionKeys?: ReadonlySet<string>;
}): SessionEntryMaintenancePlan {
  const projection = readSessionMaintenanceKeyProjection(params.database);
  const preserveKeys = collectCapacityEligibleLivePreserveKeys({
    database: params.database,
    skipSessionKeys: params.skipSessionKeys,
    store: projection,
    storePath: params.storePath,
    unprotectSessionKeys: params.unprotectSessionKeys,
  });
  const victim = readOldestCapacityEligibleLiveNode({
    database: params.database,
    preserveKeys,
    preserveRecentMs: resolveLivePreserveRecentMs(params.preserveRecentMs),
    skipSessionKeys: params.skipSessionKeys,
  });
  if (!victim) {
    return emptyLiveEntryPlan();
  }

  const removedKeys = new Set([victim.key]);
  const removedEntriesByKey = new Map([[victim.key, cloneSessionEntry(victim.entry)]]);
  // Referenced ids come from the database with the victim excluded. Cloning the
  // catalog here would mark the victim's own session id as still referenced.
  const projectedStore = { ...projection };
  delete projectedStore[victim.key];
  return planSqliteLiveEntryRemovals({
    archiveDirectory: params.archiveDirectory,
    database: params.database,
    projectedStore,
    removedEntriesByKey,
    removedKeys,
  });
}

function sqliteSessionNodeExists(database: OpenClawAgentDatabase, sessionKey: string): boolean {
  const db = getSessionKysely(database.db);
  return (
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("session_key")
        .where("session_key", "=", sessionKey)
        .limit(1),
    ).rows.length > 0
  );
}

/** Last-resort live-node disk eviction. Historical generations must already be exhausted. */
export async function reclaimSqliteLiveSessionEntriesToHighWater(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  finalizePlans: (
    scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
    plans: readonly SessionEntryMaintenancePlan[],
  ) => Promise<SessionEntryMaintenanceResult>;
  highWaterBytes: number;
  pruneArchivesToHighWater: () => Promise<{
    removedFiles: number;
    usage: SessionPhysicalDiskUsage;
    checkpointIncomplete?: number;
  }>;
  reclaimFreePages: () => boolean | void | Promise<boolean | void>;
  resolved: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">;
  storePath: string;
  usage: SessionPhysicalDiskUsage;
  preserveRecentMs?: number | null;
}): Promise<{
  removedEntries: number;
  removedFiles: number;
  usage: SessionPhysicalDiskUsage;
}> {
  let { usage } = params;
  let removedEntries = 0;
  let removedFiles = 0;
  const skipSessionKeys = new Set<string>();
  const databaseOptions = toDatabaseOptions(params.resolved);
  const livePlanParams = {
    archiveDirectory: params.archiveDirectory,
    database: params.database,
    skipSessionKeys,
    storePath: params.storePath,
    preserveRecentMs: params.preserveRecentMs,
  };
  while (usage.totalBytes > params.highWaterBytes) {
    livePlanParams.database = openOpenClawAgentDatabase(databaseOptions);
    const livePlan = planOldestCapacityEligibleSqliteLiveEntryRemoval(livePlanParams);
    const victim = livePlan.entryRemovals[0];
    if (!victim) {
      break;
    }
    const identities = uniqueStrings(
      [
        victim.sessionKey,
        victim.expectedEntry?.sessionId,
        ...readSessionGenerationIdsForKeys(livePlanParams.database, [victim.sessionKey]),
      ].filter(
        (identity): identity is string => typeof identity === "string" && identity.length > 0,
      ),
    );
    let retargeted = false;
    const published = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities,
      run: async () => {
        livePlanParams.database = openOpenClawAgentDatabase(databaseOptions);
        const fencedPlan = planOldestCapacityEligibleSqliteLiveEntryRemoval({
          ...livePlanParams,
          unprotectSessionKeys: new Set(identities),
        });
        if (fencedPlan.entryRemovals[0]?.sessionKey !== victim.sessionKey) {
          retargeted = true;
          return null;
        }
        return await params.finalizePlans(params.resolved, [fencedPlan]);
      },
    });
    if (retargeted) {
      skipSessionKeys.add(victim.sessionKey);
      usage = await measureSessionPhysicalDiskUsage(params.storePath);
      continue;
    }
    livePlanParams.database = openOpenClawAgentDatabase(databaseOptions);
    skipSessionKeys.add(victim.sessionKey);
    if (!published || sqliteSessionNodeExists(livePlanParams.database, victim.sessionKey)) {
      usage = await measureSessionPhysicalDiskUsage(params.storePath);
      continue;
    }
    removedEntries += 1;
    emitArchivedTranscriptUpdates(published.archivedTranscripts);
    const reclaimed = await params.reclaimFreePages();
    if (reclaimed === false) {
      break;
    }
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
    if (usage.totalBytes > params.highWaterBytes) {
      const repruned = await params.pruneArchivesToHighWater();
      removedFiles += repruned.removedFiles;
      usage = repruned.usage;
      if (repruned.checkpointIncomplete) {
        break;
      }
    }
    livePlanParams.database = openOpenClawAgentDatabase(databaseOptions);
  }
  return { removedEntries, removedFiles, usage };
}
