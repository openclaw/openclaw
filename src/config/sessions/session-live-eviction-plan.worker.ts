import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import {
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import { readSessionEntryStore } from "./session-accessor.sqlite-entry-inventory.js";
import {
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  hasColdSessionTranscript,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { collectSessionAdmissionReferences } from "./session-history-eviction-candidates.js";
import type {
  LiveEvictionPlan,
  LiveEvictionPlanInput,
} from "./session-history-eviction-worker.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveSessionMaintenancePreserveKeys } from "./store-maintenance-preserve-snapshot.js";
import { isRecentSessionMaintenanceEntry } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type LiveEvictionDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;

const LIVE_VICTIM_PAGE_SIZE = 64;

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

function emptyLiveEntryPlan(): SessionEntryMaintenancePlan {
  return {
    archivedEntries: [],
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
  return /* kysely-allow-raw: activity timestamp is not a stored column. */ sql<number>`CASE WHEN json_valid(entry_json) THEN MAX(
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

/** Store keys whose current or prior generation is admitted. Reads only the admitted ids. */
function collectAdmissionProtectedStoreKeys(
  database: LiveEvictionDatabase,
  admissionIdentities: readonly string[],
): Set<string> {
  const protectedIds = [...collectSessionAdmissionReferences({ database, admissionIdentities })];
  if (protectedIds.length === 0) {
    return new Set();
  }
  const keys = new Set<string>();
  const db = getSessionKysely(database.db);
  for (const row of executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select("session_key")
      .where((eb) =>
        eb.or([
          eb("session_key", "in", sqliteStringSet(protectedIds)),
          eb("current_session_id", "in", sqliteStringSet(protectedIds)),
        ]),
      ),
  ).rows) {
    keys.add(row.session_key);
  }
  for (const row of executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "in", sqliteStringSet(protectedIds)),
  ).rows) {
    keys.add(row.session_key);
  }
  return keys;
}

/** Rows that can match provider, admission, or lifecycle identities. Not the catalog. */
function readIdentityPreserveStore(
  database: LiveEvictionDatabase,
  identities: readonly string[],
): Record<string, SessionEntry> {
  const keys = [...new Set(identities.map((identity) => identity.trim()).filter(Boolean))];
  if (keys.length === 0) {
    return {};
  }
  const db = getSessionKysely(database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "parent_session_key", "session_key", "updated_at"])
      .where("archived_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("session_key", "in", sqliteStringSet(keys)),
          eb("current_session_id", "in", sqliteStringSet(keys)),
        ]),
      ),
  ).rows) {
    store[row.session_key] = {
      sessionId: row.current_session_id,
      updatedAt: row.updated_at,
      ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
    };
  }
  return store;
}

function collectCapacityEligibleLivePreserveKeys(
  database: LiveEvictionDatabase,
  input: LiveEvictionPlanInput,
): Set<string> {
  const unprotect = new Set(input.unprotectSessionKeys);
  // Drop only this eviction's lifecycle identities. A provider that starts
  // protecting the victim while the fence is waited for must still veto deletion.
  const snapshot = {
    ...input.snapshot,
    lifecycleIdentities: input.snapshot.lifecycleIdentities.filter(
      (identity) => !isLocalEvictionFenceIdentity(identity, unprotect),
    ),
  };
  const preserveKeys = resolveSessionMaintenancePreserveKeys({
    snapshot,
    store: readIdentityPreserveStore(database, [
      ...snapshot.providerKeys,
      ...snapshot.workIdentities,
      ...snapshot.lifecycleIdentities,
    ]),
  });
  for (const key of input.skipSessionKeys) {
    preserveKeys.add(key);
  }
  for (const key of collectAdmissionProtectedStoreKeys(database, snapshot.workIdentities)) {
    preserveKeys.add(key);
  }
  return preserveKeys;
}

function isCapacityEligibleLiveNode(params: {
  entry: SessionEntry;
  key: string;
  preserveKeys: ReadonlySet<string>;
  preserveRecentMs: number | null;
}): boolean {
  const { entry, key } = params;
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
  database: LiveEvictionDatabase;
  preserveKeys: ReadonlySet<string>;
  preserveRecentMs: number | null;
}): { entry: SessionEntry; key: string } | undefined {
  const db = getSessionKysely(params.database.db);
  // Alias the activity expression so the page cursor can filter it. SQLite
  // does not allow that alias in the same SELECT's WHERE.
  const candidates = db
    .selectFrom("session_nodes")
    .select(["session_key", "entry_json", liveNodeActivityAtSql().as("activity_at")])
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
      const activity = row.activity_at;
      cursor = {
        activityAt: Number.isFinite(activity) ? activity : 0,
        sessionKey: row.session_key,
      };
      const preview = parseSessionEntryRow({ entry_json: row.entry_json }, "list");
      if (
        !preview ||
        !isCapacityEligibleLiveNode({
          entry: preview,
          key: row.session_key,
          preserveKeys: params.preserveKeys,
          preserveRecentMs: params.preserveRecentMs,
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
        }) &&
        !hasColdSessionTranscript(params.database, entry)
      ) {
        return { entry, key: row.session_key };
      }
    }
    if (rows.length < LIVE_VICTIM_PAGE_SIZE) {
      return undefined;
    }
  }
}

function planSqliteLiveEntryRemoval(params: {
  archiveDirectory: string;
  database: LiveEvictionDatabase;
  entry: SessionEntry;
  generationIds: readonly string[];
  sessionKey: string;
}): SessionEntryMaintenancePlan {
  const removedSessionIds = new Set([
    ...collectSessionStateIdsForEntry(params.entry),
    ...params.generationIds,
  ]);
  // Referenced ids come from the database with the victim excluded. Cloning the
  // catalog here would mark the victim's own session id as still referenced.
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database: params.database,
    excludedSessionKeys: [params.sessionKey],
    projectedStore: {},
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
    ...emptyLiveEntryPlan(),
    entryRemovals: [
      {
        expectedEntry: { ...params.entry },
        maintenanceReason: "disk-evicted",
        sessionKey: params.sessionKey,
      },
    ],
    stateDeletePlans: deletePlans,
  };
}

/** Plans at most one oldest capacity-eligible live session_node removal.
 *
 * This is the last-resort disk-budget tier. `capEntryCount` archives ordinary
 * sessions instead of deleting them, so this bypasses the cap path and selects
 * the oldest idle live node for deletion. Always-protected entries (primary,
 * pinned, model-locked, active/admitted, recently active) are never victims.
 */
export function planLiveEvictionInDatabase(
  database: LiveEvictionDatabase,
  input: LiveEvictionPlanInput,
): LiveEvictionPlan {
  const victim = readOldestCapacityEligibleLiveNode({
    database,
    preserveKeys: collectCapacityEligibleLivePreserveKeys(database, input),
    preserveRecentMs: input.preserveRecentMs,
  });
  if (!victim) {
    return { identities: [], plan: emptyLiveEntryPlan() };
  }
  const generationIds = readSessionGenerationIdsForKeys(database, [victim.key]);
  return {
    identities: uniqueStrings(
      [victim.key, victim.entry.sessionId, ...generationIds].filter(
        (identity): identity is string => typeof identity === "string" && identity.length > 0,
      ),
    ),
    plan: planSqliteLiveEntryRemoval({
      archiveDirectory: input.archiveDirectory,
      database,
      entry: victim.entry,
      generationIds,
      sessionKey: victim.key,
    }),
  };
}
