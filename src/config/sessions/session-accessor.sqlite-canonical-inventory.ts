import type { InferResult } from "kysely";
import { iterateSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { SessionEntrySummary } from "./session-accessor.sqlite-contract.js";
import { projectSqliteSessionOwner } from "./session-accessor.sqlite-owner-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { scanCanonicalSqliteSessionEntries } from "./session-canonical-key.js";
import { admitCanonicalSessionEntry } from "./session-entry-json.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import { sessionEntrySnapshotColumns } from "./session-entry-snapshots.js";
import type { SessionEntry } from "./types.js";

type CanonicalRepairRow = InferResult<ReturnType<typeof canonicalRepairQuery>>[number];

export type CanonicalSessionRepairFact = {
  canonicalOwnerSessionKey?: string;
  delivery?: SessionEntry["delivery"];
  forkSourceSessionKey?: string;
  groupId?: string;
  parentSessionKey?: string;
  rawCompareRequired: boolean;
  sessionKey: string;
  spawnedBy?: string;
};

type ScannedCanonicalSessionFact = {
  currentSessionId: string;
  currentWindowOwnerSessionKey: string | null;
  decision: Omit<CanonicalSessionRepairFact, "canonicalOwnerSessionKey">;
  entryJsonIsEmpty: boolean;
};

export type DoctorSessionScanScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
};

type DoctorSessionEntrySummary = SessionEntrySummary & {
  recoveredFromProjections: boolean;
};

type CanonicalSessionRepairEntry = SessionEntrySummary &
  (
    | { rawEntryJson: string; rawSnapshotRevision: number }
    | { rawEntryJson?: never; rawSnapshotRevision?: never }
  );

/** Doctor inventory hydrates rejected legacy blobs from promoted node/window columns. */
function hydrateCanonicalRepairEntry(row: CanonicalRepairRow): SessionEntry {
  let record: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    // Doctor owns malformed legacy repair; promoted identity columns keep the row reachable.
  }
  attachSessionEntrySnapshots(record, row);
  const createdActor = row.created_actor_type
    ? {
        type: row.created_actor_type,
        ...(row.created_actor_type === "human" ? { source: "unknown" as const } : {}),
        ...(row.created_actor_id ? { id: row.created_actor_id } : {}),
      }
    : undefined;
  const forkSource =
    row.fork_source_session_key && row.fork_source_session_id
      ? {
          sessionKey: row.fork_source_session_key,
          sessionId: row.fork_source_session_id,
          ...(row.fork_source_entry_id ? { entryId: row.fork_source_entry_id } : {}),
        }
      : undefined;
  const delivery =
    row.delivery_channel && row.delivery_target
      ? normalizeSessionDeliveryState({
          context: {
            channel: row.delivery_channel,
            to: row.delivery_target,
            ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
            ...(row.delivery_thread_id ? { threadId: row.delivery_thread_id } : {}),
          },
        })
      : undefined;
  const entry = admitCanonicalSessionEntry({
    ...record,
    ...(row.status ? { status: row.status } : {}),
    ...(row.current_started_at !== null ? { startedAt: row.current_started_at } : {}),
    ...(row.current_ended_at !== null ? { endedAt: row.current_ended_at } : {}),
    ...(row.current_chat_type ? { chatType: row.current_chat_type } : {}),
    ...(row.current_model_provider ? { modelProvider: row.current_model_provider } : {}),
    ...(row.current_model ? { model: row.current_model } : {}),
    ...(row.current_previous_session_id
      ? { previousSessionId: row.current_previous_session_id }
      : {}),
    ...(row.current_agent_harness_id ? { agentHarnessId: row.current_agent_harness_id } : {}),
    ...(delivery ? { delivery } : {}),
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    ...(row.created_via ? { createdVia: row.created_via } : {}),
    ...(createdActor ? { createdActor } : {}),
    ...(row.spawned_by ? { spawnedBy: row.spawned_by } : {}),
    ...(row.parent_session_key && row.parent_session_key !== row.spawned_by
      ? { parentSessionKey: row.parent_session_key }
      : {}),
    ...(forkSource ? { forkSource } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.pinned_at !== null ? { pinnedAt: row.pinned_at } : {}),
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    ...(row.last_read_at !== null ? { lastReadAt: row.last_read_at } : {}),
    ...(row.last_interaction_at !== null ? { lastInteractionAt: row.last_interaction_at } : {}),
    ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    // The canonical parser rejected this blob, so duplicate or malformed identity fields are
    // untrusted. Promoted columns remain the durable transcript identity for doctor repair.
    sessionId: row.current_session_id,
    updatedAt: row.updated_at,
  });
  return projectSqliteSessionOwner(entry, row);
}

function canonicalRepairQuery(
  database: Pick<OpenClawAgentDatabase, "db">,
  includeSnapshots = true,
) {
  const db = getSessionKysely(database.db);
  return db
    .selectFrom("session_nodes")
    .leftJoin("session_windows as current_window", (join) =>
      join
        .onRef("current_window.session_id", "=", "session_nodes.current_session_id")
        .onRef("current_window.session_key", "=", "session_nodes.session_key"),
    )
    .leftJoin(
      "session_windows as current_window_owner",
      "current_window_owner.session_id",
      "session_nodes.current_session_id",
    )
    .leftJoin(
      "conversations as current_conversation",
      "current_conversation.conversation_id",
      "current_window.primary_conversation_id",
    )
    .selectAll("session_nodes")
    .$if(includeSnapshots, (query) => query.select(sessionEntrySnapshotColumns))
    .select([
      "current_window_owner.session_key as current_window_owner_session_key",
      "current_window.started_at as current_started_at",
      "current_window.ended_at as current_ended_at",
      "current_window.chat_type as current_chat_type",
      "current_window.model_provider as current_model_provider",
      "current_window.model as current_model",
      "current_window.previous_session_id as current_previous_session_id",
      "current_window.agent_harness_id as current_agent_harness_id",
      "current_conversation.channel as delivery_channel",
      "current_conversation.account_id as delivery_account_id",
      "current_conversation.delivery_target",
      "current_conversation.thread_id as delivery_thread_id",
    ])
    .orderBy("session_nodes.session_key");
}

function scanCanonicalSessionFactsFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  includeSnapshots = true,
): CanonicalSessionRepairFact[] {
  const scanned: ScannedCanonicalSessionFact[] = [];
  const validSessionKeysById = new Map<string, string[]>();
  const inventoriedSessionKeys = new Set<string>();
  for (const row of iterateSqliteQuerySync(
    database.db,
    canonicalRepairQuery(database, includeSnapshots),
  )) {
    inventoriedSessionKeys.add(row.session_key);
    const persistedEntry = parseSessionEntryJson(row);
    if (row.entry_valid === 1 && persistedEntry) {
      const keys = validSessionKeysById.get(row.current_session_id) ?? [];
      keys.push(row.session_key);
      validSessionKeysById.set(row.current_session_id, keys);
    }
    const entry = persistedEntry ?? hydrateCanonicalRepairEntry(row);
    const lineageProjectionMismatch = Boolean(
      persistedEntry &&
      ((row.parent_session_key ?? undefined) !==
        (persistedEntry.parentSessionKey ?? persistedEntry.spawnedBy ?? undefined) ||
        (row.spawned_by ?? undefined) !== (persistedEntry.spawnedBy ?? undefined) ||
        (row.fork_source_session_key ?? undefined) !==
          (persistedEntry.forkSource?.sessionKey ?? undefined)),
    );
    const decision = {
      delivery: entry.delivery,
      forkSourceSessionKey: entry.forkSource?.sessionKey,
      groupId: entry.groupId,
      parentSessionKey: entry.parentSessionKey,
      rawCompareRequired: row.entry_valid !== 1 || !persistedEntry || lineageProjectionMismatch,
      sessionKey: row.session_key,
      spawnedBy: entry.spawnedBy,
    };
    scanned.push({
      currentSessionId: row.current_session_id,
      currentWindowOwnerSessionKey: row.current_window_owner_session_key,
      decision,
      entryJsonIsEmpty: row.entry_json === "{}",
    });
  }
  const facts: CanonicalSessionRepairFact[] = [];
  for (const fact of scanned) {
    const isEmptyWindowOwner =
      fact.entryJsonIsEmpty && fact.currentWindowOwnerSessionKey === fact.decision.sessionKey;
    const competingValidKeys = (validSessionKeysById.get(fact.currentSessionId) ?? [])
      .filter((sessionKey) => sessionKey !== fact.decision.sessionKey)
      .toSorted();
    const canonicalOwnerSessionKey = isEmptyWindowOwner
      ? competingValidKeys.length === 1
        ? competingValidKeys[0]
        : undefined
      : fact.entryJsonIsEmpty &&
          fact.currentWindowOwnerSessionKey &&
          inventoriedSessionKeys.has(fact.currentWindowOwnerSessionKey)
        ? fact.currentWindowOwnerSessionKey
        : undefined;
    if (!isEmptyWindowOwner || canonicalOwnerSessionKey) {
      facts.push({
        ...fact.decision,
        ...(canonicalOwnerSessionKey ? { canonicalOwnerSessionKey } : {}),
      });
    }
  }
  return facts;
}

function loadCanonicalRepairEntriesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  facts: readonly CanonicalSessionRepairFact[],
): CanonicalSessionRepairEntry[] {
  // Selection and hydration are synchronous under offline Doctor ownership. Recheck
  // the selected rows at mutation, not the whole inventory between these steps.
  const rows = new Map(
    Array.from(
      iterateSqliteQuerySync(
        database.db,
        canonicalRepairQuery(database).where(
          "session_nodes.session_key",
          "in",
          sqliteStringSet(facts.map((fact) => fact.sessionKey)),
        ),
      ),
      (row) => [row.session_key, row],
    ),
  );
  return facts.map((fact) => {
    const row = rows.get(fact.sessionKey);
    if (!row) {
      throw new Error(`Canonical session repair row disappeared during scan: ${fact.sessionKey}`);
    }
    const summary = {
      entry: parseSessionEntryJson(row) ?? hydrateCanonicalRepairEntry(row),
      sessionKey: fact.sessionKey,
    };
    return fact.rawCompareRequired
      ? {
          ...summary,
          rawEntryJson: row.entry_json,
          rawSnapshotRevision: row.snapshot_revision,
        }
      : summary;
  });
}

export function listCanonicalSessionRepairFacts(
  scope: DoctorSessionScanScope,
): CanonicalSessionRepairFact[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    scanCanonicalSessionFactsFromDatabase,
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

export function loadCanonicalSessionRepairEntries(
  scope: DoctorSessionScanScope,
  facts: readonly CanonicalSessionRepairFact[],
): CanonicalSessionRepairEntry[] {
  if (facts.length === 0) {
    return [];
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => loadCanonicalRepairEntriesFromDatabase(database, facts),
    toDatabaseOptions(resolved),
  );
  if (!result.found) {
    throw new Error("Canonical session repair database disappeared during scan; retry Doctor");
  }
  return result.value;
}

/** Strict Doctor scan of canonical rows, ordered by durable session key. */
export function scanDoctorSessionEntriesStrict(
  scope: DoctorSessionScanScope,
  visit: (summary: DoctorSessionEntrySummary) => void,
): number {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    let count = 0;
    scanCanonicalSqliteSessionEntries(database, ({ entry, sessionKey }) => {
      if (isInternalSessionEffectsKey(sessionKey)) {
        return;
      }
      visit({ entry, recoveredFromProjections: false, sessionKey });
      count += 1;
    });
    return count;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : 0;
}

/** Tolerant Doctor preview scan with canonical-repair tombstone eligibility. */
export function scanDoctorSessionEntriesTolerant(
  scope: DoctorSessionScanScope,
  visit: (summary: DoctorSessionEntrySummary) => void,
): number {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    // Eligibility uses hot identity/delivery fields; load cold snapshots only in the visitor pass.
    const eligible = new Set(
      scanCanonicalSessionFactsFromDatabase(database, false).map((fact) => fact.sessionKey),
    );
    let count = 0;
    for (const row of iterateSqliteQuerySync(database.db, canonicalRepairQuery(database))) {
      const persistedEntry = parseSessionEntryJson(row);
      // Excluded tombstones still participate in malformed-snapshot refusal.
      const entry = persistedEntry ?? hydrateCanonicalRepairEntry(row);
      if (!eligible.has(row.session_key) || isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      visit({
        entry,
        recoveredFromProjections: persistedEntry === null,
        sessionKey: row.session_key,
      });
      count += 1;
    }
    return count;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : 0;
}
