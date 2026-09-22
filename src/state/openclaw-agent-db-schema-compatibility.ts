import { MEMORY_INDEX_CHUNK_PROVENANCE_TABLE } from "../../packages/memory-host-sdk/src/host/memory-schema-provenance.js";
import { MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE } from "../../packages/memory-host-sdk/src/host/memory-schema-recall.js";
import {
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import type { SqliteSchemaCompatibility } from "../infra/sqlite-schema-contract.js";
import { CONTEXT_ENGINE_TURN_OUTBOX_TABLE } from "./openclaw-agent-context-engine-turn-outbox-schema.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "./openclaw-agent-db-additive-columns.js";
import { SESSION_PARTICIPANTS_TABLE } from "./openclaw-agent-db-contract.js";
import { SESSION_GOAL_OPERATIONS_TABLE } from "./openclaw-agent-goal-operations-schema.js";
import { MESSAGE_TOOL_RUN_OUTCOMES_TABLE } from "./openclaw-agent-message-tool-outcome-schema.js";
import {
  SESSION_PENDING_INPUTS_TABLE,
  SESSION_INPUT_COMPLETIONS_TABLE,
} from "./openclaw-agent-pending-inputs-schema.js";
import { SESSION_PROGRESS_CARDS_TABLE } from "./openclaw-agent-progress-card-schema.js";
import { SESSION_TRANSCRIPT_ARCHIVES_TABLE } from "./openclaw-agent-session-transcript-archive-schema.js";
import {
  STANDING_INTENTS_FTS_SHADOW_TABLES,
  STANDING_INTENTS_FTS_TABLE,
  STANDING_INTENTS_TABLE,
} from "./openclaw-agent-standing-intents-schema.js";

export const AGENT_SCHEMA_COMPATIBILITY = {
  allowCompatibleAdditiveColumns: true,
  allowedMissingTables: [
    "memory_entry_origins",
    "memory_session_tombstones",
    MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
    MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
    CONTEXT_ENGINE_TURN_OUTBOX_TABLE,
    MESSAGE_TOOL_RUN_OUTCOMES_TABLE,
    SESSION_GOAL_OPERATIONS_TABLE,
    SESSION_PENDING_INPUTS_TABLE,
    SESSION_INPUT_COMPLETIONS_TABLE,
    SESSION_PARTICIPANTS_TABLE,
    SESSION_PROGRESS_CARDS_TABLE,
    SESSION_TRANSCRIPT_ARCHIVES_TABLE,
    STANDING_INTENTS_TABLE,
    STANDING_INTENTS_FTS_TABLE,
    ...STANDING_INTENTS_FTS_SHADOW_TABLES,
  ],
  allowedMissingColumns: [
    "session_pending_inputs.consumed_event_id",
    "session_transcript_active_events.context_eligible",
    "session_conversations.route_context_json",
    "standing_intents.creator_sender",
    ...FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS.map(
      ({ columnName, tableName }) => `${tableName}.${columnName}`,
    ),
  ],
  allowedColumnDefinitions: {
    "conversations.delivery_target": ["delivery_target TEXT NOT NULL DEFAULT ''"],
  },
  allowedMissingIndexes: [
    "idx_agent_transcript_context_pending",
    "idx_agent_session_nodes_label",
    "idx_agent_session_nodes_entry_not_valid",
  ],
  optionalCanonicalTriggerGroups: [
    {
      tableName: "memory_index_chunks",
      triggers: MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS,
    },
    {
      tableName: MEMORY_INDEX_SOURCES_TABLE,
      triggers: MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
    },
  ],
} satisfies SqliteSchemaCompatibility;
