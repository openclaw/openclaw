import type { SessionTreeEntry } from "@openclaw/agent-core";
import { jsonArrayFrom, jsonObjectFrom } from "kysely/helpers/sqlite";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { parseReadableSessionEntryData } from "./session-accessor.sqlite-entry-read.js";
import {
  readParticipantRecord,
  withProjectedParticipants,
} from "./session-accessor.sqlite-participant-projection.js";
import type {
  SessionActorHotState,
  SessionActorTarget,
  SessionActorVersion,
} from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { canonicalSessionValidationQuery } from "./session-canonical-key.js";
import { sessionColdArchiveMetadataColumns } from "./session-cold-storage-state.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import { sessionEntrySnapshotColumnsForKeys } from "./session-entry-snapshots.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { transcriptEventModelNavigationSql } from "./transcript-payload.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

// Kysely's SQLite JSON helpers retain their SQL result type but node:sqlite returns TEXT.
function decodeJsonProjection<T>(value: T | string): T {
  if (typeof value !== "string") {
    return value;
  }
  const decoded: unknown = JSON.parse(value);
  const checkNumbers = (item: unknown): void => {
    if (typeof item === "number" && !Number.isSafeInteger(item)) {
      throw new RangeError("Session actor storage integer cannot be represented safely");
    }
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) {
        checkNumbers(child);
      }
    }
  };
  checkNumbers(decoded);
  // SAFETY: The typed query builds every JSON object from its declared database columns.
  return decoded as T;
}

/** One statement admits all hot facts, inside the command transaction or an autocommit read. */
export function hydrateSessionActorState(
  database: OpenClawAgentDatabase,
  target: SessionActorTarget,
  version: SessionActorVersion,
  writeToken: string,
): SessionActorStoredState {
  const keys = collectSessionEntryLookupKeys(target.sessionKey);
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  const tables = getAdmittedSqliteSchemaFacts(database.db)?.tables;
  const rows = executeSqliteQuerySync(
    database.db,
    canonicalSessionValidationQuery(database, { metadata: true })
      .selectAll("session_nodes")
      .select(sessionEntrySnapshotColumnsForKeys(undefined, "full"))
      .select((eb) => [
        (tables?.has("board_tabs")
          ? eb.exists(
              db
                .selectFrom("board_tabs")
                .select("session_key")
                .where("board_tabs.session_key", "=", eb.ref("session_nodes.session_key")),
            )
          : eb.lit(0)
        ).as("actor_has_board"),
        jsonArrayFrom(
          db
            .selectFrom("session_participants")
            .select([
              "actor_id",
              "contribution_count",
              "first_prompted_at",
              "identity_namespace",
              "last_prompted_at",
              "session_key",
            ])
            .where("session_participants.session_key", "=", eb.ref("session_nodes.session_key"))
            .orderBy("first_prompted_at")
            .orderBy("actor_id")
            .orderBy("identity_namespace"),
        ).as("actor_participants"),
        jsonArrayFrom(
          db
            .selectFrom("session_members")
            .select(["added_at", "added_by", "identity_id", "session_key"])
            .where("session_members.session_key", "=", eb.ref("session_nodes.session_key"))
            .orderBy("identity_id"),
        ).as("actor_members"),
        tables?.has("session_pending_inputs")
          ? jsonArrayFrom(
              db
                .selectFrom("session_pending_inputs")
                .select([
                  "accepted_at",
                  "consumed_event_id",
                  "idempotency_key",
                  "input_id",
                  "lifecycle_generation",
                  "message_json",
                  "request_hash",
                  "run_id",
                  "seq",
                  "session_id",
                  "session_key",
                  "state",
                ])
                .where(
                  "session_pending_inputs.session_key",
                  "=",
                  eb.ref("session_nodes.session_key"),
                )
                .where(
                  "session_pending_inputs.session_id",
                  "=",
                  eb.ref("session_nodes.current_session_id"),
                )
                .orderBy("accepted_at")
                .orderBy("input_id"),
            ).as("actor_pending")
          : eb.val("[]").as("actor_pending"),
        tables?.has("session_input_completions")
          ? jsonArrayFrom(
              db
                .selectFrom("session_input_completions")
                .select([
                  "completed_at",
                  "idempotency_key",
                  "outcome_json",
                  "request_hash",
                  "run_id",
                  "session_id",
                  "session_key",
                  "succeeded",
                ])
                .where(
                  "session_input_completions.session_key",
                  "=",
                  eb.ref("session_nodes.session_key"),
                )
                .where(
                  "session_input_completions.session_id",
                  "=",
                  eb.ref("session_nodes.current_session_id"),
                ),
            ).as("actor_completions")
          : eb.val("[]").as("actor_completions"),
        jsonObjectFrom(
          db
            .selectFrom("session_windows")
            .select([
              "account_id",
              "acp_owned",
              "agent_harness_id",
              "channel",
              "chat_type",
              "created_at",
              "display_name",
              "ended_at",
              "hook_external_content_source",
              "model",
              "model_provider",
              "parent_session_key",
              "plugin_owner_id",
              "previous_session_id",
              "primary_conversation_id",
              "reason",
              "session_entry_provenance",
              "session_id",
              "session_key",
              "session_scope",
              "spawned_by",
              "started_at",
              "status",
              "transcript_observed_at",
              "transcript_updated_at",
              "updated_at",
            ])
            .where("session_windows.session_id", "=", eb.ref("session_nodes.current_session_id")),
        ).as("actor_window"),
        jsonObjectFrom(
          db
            .selectFrom("transcript_rewrite_watermarks")
            .select(["generation", "session_id", "updated_at"])
            .where(
              "transcript_rewrite_watermarks.session_id",
              "=",
              eb.ref("session_nodes.current_session_id"),
            ),
        ).as("actor_rewrite"),
        jsonObjectFrom(
          db
            .selectFrom("session_transcript_cold_archives")
            .select(sessionColdArchiveMetadataColumns)
            .where(
              "session_transcript_cold_archives.session_id",
              "=",
              eb.ref("session_nodes.current_session_id"),
            ),
        ).as("actor_cold"),
        jsonObjectFrom(
          db
            .selectFrom("session_transcript_index_state")
            .select([
              "active_event_count",
              "active_message_count",
              "indexed_seq",
              "leaf_event_id",
              "needs_rebuild",
              "session_id",
              "updated_at",
            ])
            .where(
              "session_transcript_index_state.session_id",
              "=",
              eb.ref("session_nodes.current_session_id"),
            ),
        ).as("actor_projection"),
        jsonArrayFrom(
          db
            .selectFrom("transcript_event_identities")
            .select([
              "created_at",
              "event_id",
              "event_type",
              "message_idempotency_key",
              "parent_id",
              "seq",
              "session_id",
            ])
            .where(
              "transcript_event_identities.session_id",
              "=",
              eb.ref("session_nodes.current_session_id"),
            )
            .orderBy("seq"),
        ).as("actor_identities"),
        jsonArrayFrom(
          db
            .selectFrom("session_transcript_active_events")
            .select([
              "active_position",
              "context_eligible",
              "event_seq",
              "message_position",
              "session_id",
            ])
            .where(
              "session_transcript_active_events.session_id",
              "=",
              eb.ref("session_nodes.current_session_id"),
            )
            .orderBy("active_position"),
        ).as("actor_active"),
        jsonArrayFrom(
          db
            .selectFrom("transcript_events")
            .select(["seq", transcriptEventModelNavigationSql().as("navigation_json")])
            .where("transcript_events.session_id", "=", eb.ref("session_nodes.current_session_id"))
            .orderBy("seq"),
        ).as("actor_navigation"),
      ])
      .where("session_nodes.session_key", "in", sqliteStringSet(keys)),
  ).rows;
  const selected = rows.find((row) => row.session_key === target.sessionKey);
  const entryRows: SessionActorStoredState["entryRows"] = new Map(
    keys.map((key) => [key, undefined]),
  );
  for (const row of rows) {
    const entry = parseReadableSessionEntryData(database, row, "full");
    const participants = decodeJsonProjection(row.actor_participants).map(readParticipantRecord);
    entryRows.set(
      row.session_key,
      entry
        ? {
            row: {
              current_session_id: row.current_session_id,
              entry_json: row.entry_json,
              session_key: row.session_key,
              updated_at: row.updated_at,
              owner_actor_type: row.owner_actor_type,
              owner_actor_id: row.owner_actor_id,
              owner_assigned_by_type: row.owner_assigned_by_type,
              owner_assigned_by_id: row.owner_assigned_by_id,
              owner_assigned_at: row.owner_assigned_at,
              legacy_acp_migration_json: row.legacy_acp_migration_json,
              session_diff_baseline_json: row.session_diff_baseline_json,
              skills_snapshot_json: row.skills_snapshot_json,
              system_prompt_report_json: row.system_prompt_report_json,
            },
            entry: withProjectedParticipants(entry, participants),
          }
        : undefined,
    );
  }
  const entry = entryRows.get(target.sessionKey)?.entry;
  const participants = selected
    ? decodeJsonProjection(selected.actor_participants).map(readParticipantRecord)
    : [];
  const members = selected
    ? decodeJsonProjection(selected.actor_members).map((member) => ({
        identityId: member.identity_id,
        addedBy: member.added_by,
        addedAt: member.added_at,
      }))
    : [];
  const pendingInputs = new Map(
    (selected ? decodeJsonProjection(selected.actor_pending) : []).map((row) => [
      row.idempotency_key,
      row,
    ]),
  );
  const completions = new Map(
    (selected ? decodeJsonProjection(selected.actor_completions) : []).map((row) => [
      row.idempotency_key,
      row,
    ]),
  );
  const window = selected ? (decodeJsonProjection(selected.actor_window) ?? undefined) : undefined;
  const rewrite = selected ? decodeJsonProjection(selected.actor_rewrite) : undefined;
  const coldArchive = selected
    ? (decodeJsonProjection(selected.actor_cold) ?? undefined)
    : undefined;
  const projection = selected ? decodeJsonProjection(selected.actor_projection) : undefined;
  const identities = new Map(
    (selected ? decodeJsonProjection(selected.actor_identities) : []).map((row) => [
      row.event_id,
      row,
    ]),
  );
  const active = new Map(
    (selected ? decodeJsonProjection(selected.actor_active) : []).map((row) => [
      row.event_seq,
      row,
    ]),
  );
  const navigation = (selected ? decodeJsonProjection(selected.actor_navigation) : []).map((row) =>
    Object.assign(
      // SAFETY: The canonical model codec preserves discriminants with readable empty payloads.
      JSON.parse(row.navigation_json) as SessionTreeEntry,
      { seq: row.seq },
    ),
  );
  const contextVersion = {
    generation: rewrite?.generation ?? null,
    rawSeq: coldArchive?.last_seq ?? navigation.at(-1)?.seq ?? null,
    updatedAt: window?.transcript_updated_at ?? null,
  };
  const state: SessionActorStoredState = {
    agentId: database.agentId,
    path: database.path,
    hot: {
      target,
      version,
      writeToken,
      dependencySessionIds: [],
      entry,
      hasBoard: Boolean(selected?.actor_has_board),
      participants,
      members,
      pendingInputs: [],
      completionKeys: [],
      transcript: {
        version: contextVersion,
        watermark: { generation: contextVersion.generation, maxSeq: contextVersion.rawSeq },
        anchorsState: "unavailable",
        anchors: [],
        idempotency: [],
        modelContext: { kind: "resident", entries: [] },
      },
    },
    entryRows,
    window,
    hasBoard: Boolean(selected?.actor_has_board),
    pendingInputs,
    completions,
    transcript: {
      coldArchive,
      identities,
      active,
      navigation,
      payloads: new Map(),
      projection: projection
        ? {
            activeEventCount: projection.active_event_count,
            activeMessageCount: projection.active_message_count,
            indexedSeq: projection.indexed_seq,
            leafEventId: projection.leaf_event_id,
            needsRebuild: projection.needs_rebuild !== 0,
            hasUnclassifiedEvents: [...active.values()].some(
              (row) => row.context_eligible === null,
            ),
          }
        : undefined,
    },
  };
  state.hot = projectSessionActorHotState(state);
  return state;
}

/** Derives disclosure only from the actor's owned postimage, without touching SQLite. */
export function projectSessionActorHotState(state: SessionActorStoredState): SessionActorHotState {
  const hot = structuredClone(state.hot);
  hot.hasBoard = state.hasBoard;
  hot.dependencySessionIds = [
    ...new Set([
      ...[...state.entryRows.values()].flatMap((row) => (row ? [row.entry.sessionId] : [])),
      ...(state.window ? [state.window.session_id] : []),
      ...(hot.entry ? [hot.entry.sessionId] : []),
    ]),
  ].toSorted();
  hot.pendingInputs = [...state.pendingInputs.values()].map(
    ({ message_json: _message, ...row }) => row,
  );
  hot.completionKeys = [...state.completions.keys()];
  hot.transcript.idempotency = [...state.transcript.identities.values()].flatMap((row) =>
    row.message_idempotency_key
      ? [{ key: row.message_idempotency_key, eventId: row.event_id, rawSeq: row.seq }]
      : [],
  );
  hot.transcript.anchors = [];
  hot.transcript.anchorsState =
    !state.transcript.coldArchive && hot.transcript.version.rawSeq === null
      ? "resident"
      : "unavailable";
  const generation = hot.transcript.version.generation;
  const projection = state.transcript.projection;
  if (
    !state.transcript.coldArchive &&
    hot.entry &&
    generation &&
    projection &&
    !projection.needsRebuild &&
    !projection.hasUnclassifiedEvents &&
    projection.indexedSeq === hot.transcript.version.rawSeq
  ) {
    hot.transcript.anchorsState = "resident";
    for (const row of state.transcript.identities.values()) {
      const active = state.transcript.active.get(row.seq);
      if (active?.message_position === undefined || active.message_position === null) {
        continue;
      }
      hot.transcript.anchors.push({
        agentId: state.agentId,
        sessionKey: hot.target.sessionKey,
        sessionId: hot.entry.sessionId,
        storePath: state.path,
        generation,
        entryId: row.event_id,
        rawSeq: row.seq,
        effectiveParentId: row.parent_id,
        activeMessagePosition: active.message_position,
        ...(row.message_idempotency_key ? { idempotencyKey: row.message_idempotency_key } : {}),
      });
    }
  }
  if (state.transcript.coldArchive) {
    hot.transcript.modelContext = { kind: "unavailable", reason: "cold", generation };
  } else {
    const navigation = structuredClone(state.transcript.navigation);
    const tree = scanSessionTranscriptTree(navigation);
    if (tree.hasInvalidLeafControl) {
      hot.transcript.modelContext = { kind: "unavailable", reason: "projection", generation };
    } else {
      const entries = normalizeSessionContextEntryBoundaries(
        selectSessionTranscriptTreePathNodes(tree, tree.leafId).map(({ entry, parentId }) =>
          Object.assign({}, entry, { parentId }),
        ),
        tree.nodes,
      );
      hot.transcript.modelContext = {
        kind: "resident",
        entries: [...iterateSessionContextEntries(entries)].map(({ entry }) => ({
          rawSeq: entry.seq,
          eventId: entry.id ?? null,
        })),
      };
    }
  }
  return hot;
}
