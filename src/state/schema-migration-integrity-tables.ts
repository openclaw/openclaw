import { STARTUP_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "./openclaw-agent-db-additive-columns.js";
import {
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS,
} from "./openclaw-state-db-additive-columns.js";
import { SCHEMA_MIGRATION_BACKUP_TABLES } from "./schema-migration-backup-tables.js";

type SchemaMigration = {
  kind: "agent" | "state";
  foundVersion: number;
  supportedVersion: number;
};

const indexStatistics = ["sqlite_stat1", "sqlite_stat4"];

// Historical convergence can install these projections alongside a version step.
// This is an integrity scope, not permission to back up only these tables.
export const SCHEMA_MIGRATION_HISTORICAL_REPAIR_TABLES: Readonly<
  Record<SchemaMigration["kind"], readonly string[]>
> = {
  agent: [
    "auth_profile_store",
    "auth_profile_state",
    "session_nodes",
    "session_entry_snapshots",
    "session_windows",
    "session_key_contract",
    "session_canonical_validation_pending",
    "memory_index_chunks",
    "memory_index_chunk_recall_metadata",
    "memory_index_chunk_provenance",
    "memory_index_sources",
    "memory_index_paths_fts",
    "memory_index_state",
    ...indexStatistics,
  ],
  state: [
    ...CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS.map(({ tableName }) => tableName),
    ...Object.values(ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS).flatMap((columns) =>
      columns.map(([tableName]) => tableName),
    ),
    "audit_events",
    "audit_identity_keys",
    "operator_approvals",
    "session_watch_cursors",
    "subagent_runs",
    "worker_session_placements",
    "meeting_transcript_sessions",
    "meeting_transcript_summaries",
    "delivery_queue_entries",
    "worker_turn_tool_authorities",
    "worker_session_tool_operations",
    "migration_runs",
    "sqlite_sequence",
    ...indexStatistics,
  ],
};

// Source tables remain listed when a migration consumes and then drops them.
// Preflight can check them; the finalizer skips tables absent after the cutover.
const migrationTables: Readonly<
  Record<SchemaMigration["kind"], Readonly<Partial<Record<number, readonly string[]>>>>
> = {
  agent: {
    ...SCHEMA_MIGRATION_BACKUP_TABLES.agent,
    // Only the stored CHECK definition widens; no transcript rows or indexes change.
    39: [],
    10: ["session_transcript_active_events", "session_transcript_index_state"],
    11: ["sessions", "conversations", "session_conversations"],
    13: ["transcript_rewrite_watermarks"],
    14: [
      "sessions",
      "session_entries",
      "session_routes",
      "session_nodes",
      "session_windows",
      "session_transcript_generations",
      "transcript_rewrite_watermarks",
      "board_tabs",
      "board_widgets",
      "heartbeat_outcomes",
      "session_members",
      "session_transcript_index_state",
    ],
    17: ["state_leases"],
    18: ["session_participants"],
    19: ["session_nodes"],
    21: ["session_key_contract", "session_canonical_validation_pending"],
    22: ["session_transcript_fts_rows"],
    23: [
      "transcript_events",
      "session_transcript_fts",
      "session_transcript_fts_rows",
      "session_transcript_index_state",
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_chunk_recall_metadata",
      "memory_embedding_cache",
      "memory_index_meta",
      "memory_index_state",
      "cache_entries",
    ],
    24: ["session_nodes", "session_entry_snapshots"],
    25: [
      "session_pending_inputs",
      "session_nodes",
      "session_windows",
      "session_key_contract",
      "session_canonical_validation_pending",
    ],
    26: ["session_nodes", "context_engine_turn_outbox", "transcript_events"],
  },
  state: {
    ...SCHEMA_MIGRATION_BACKUP_TABLES.state,
    2: ["audit_events", "audit_identity_keys", "sqlite_sequence"],
    4: ["session_watch_cursors"],
    7: ["commitments"],
    8: ["worker_session_placements"],
    9: ["agent_databases"],
    10: [
      "agent_model_catalogs",
      "android_notification_recent_packages",
      "command_log_entries",
      "diagnostic_stability_bundles",
      "media_blobs",
      "model_capability_cache",
    ],
    11: ["skill_lifecycle", "skill_workshop_proposal_origin_runs"],
    12: [
      "config_machine_state",
      "skill_curator_state",
      "update_check_state",
      "clawhub_promotions_feed_state",
      "model_catalog_remote",
      "voicewake_triggers",
      "voicewake_routing_routes",
      "voicewake_routing_config",
      "onboarding_recommendations",
      "cron_store_epochs",
      "tui_last_sessions",
      "sidebar_sections",
      "node_host_config",
      "web_push_vapid_keys",
    ],
    13: [
      "cron_jobs",
      "subagent_runs",
      "workspace_setup_state",
      "workspace_attestations",
      "workspace_generated_bootstrap_hashes",
      "auth_profile_stores",
      "auth_profile_state",
      "installed_plugin_index",
      "config_machine_state",
      "diagnostic_events",
    ],
    14: ["cron_jobs"],
    15: ["current_conversation_bindings"],
    17: ["worker_environments"],
    18: ["github_publication_session_lifecycles", "github_repository_publication_requests"],
    20: ["cron_run_receipts"],
    21: [
      "meeting_transcript_sessions",
      "meeting_transcript_summaries",
      "delivery_queue_entries",
      ...indexStatistics,
    ],
    22: [
      "worker_session_placements",
      "meeting_transcript_sessions",
      "meeting_transcript_summaries",
      "delivery_queue_entries",
      "acp_sessions",
      "operator_approvals",
      "cron_run_receipts",
      "execution_decision_facts",
      "skill_workshop_changes",
      ...indexStatistics,
    ],
    24: ["task_runs", ...indexStatistics],
    // v25 only advances the version fence; it has no row or table migration.
    25: [],
  },
};

/** Cumulative mutation scope; STRICT and index-repair owners check their actual rebuilds. */
export function resolveSchemaMigrationIntegrityTables(
  migration: SchemaMigration,
): readonly string[] {
  // This crossing changes only the stored constraint, including its finalizer.
  if (
    migration.kind === "agent" &&
    migration.foundVersion === 38 &&
    migration.supportedVersion === 39
  ) {
    return ["schema_meta"];
  }
  const tables = new Set(["schema_meta"]);
  if (migration.foundVersion === migration.supportedVersion) {
    for (const table of SCHEMA_MIGRATION_HISTORICAL_REPAIR_TABLES[migration.kind]) {
      tables.add(table);
    }
  }
  for (let version = migration.foundVersion + 1; version <= migration.supportedVersion; version++) {
    for (const table of migrationTables[migration.kind][version] ?? []) {
      tables.add(table);
    }
  }
  if (migration.kind === "agent") {
    for (const { tableName } of STARTUP_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
      tables.add(tableName);
    }
    if (migration.foundVersion < 20) {
      tables.add("board_widgets");
      tables.add("memory_index_sources");
      tables.add("memory_index_paths_fts");
    }
    if (migration.foundVersion < 25) {
      for (const table of SCHEMA_MIGRATION_HISTORICAL_REPAIR_TABLES.agent) {
        tables.add(table);
      }
    }
  } else {
    tables.add("config_machine_state");
    if (migration.foundVersion < 20) {
      for (const table of SCHEMA_MIGRATION_HISTORICAL_REPAIR_TABLES.state) {
        tables.add(table);
      }
    }
  }
  return [...tables].toSorted();
}
