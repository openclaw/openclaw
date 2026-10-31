import type { DatabaseSync } from "node:sqlite";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";

export type OpenClawStateSchemaReadAdmission = (database: DatabaseSync) => (() => void) | undefined;

export const MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION = 23;
export const CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION = 29;
export { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
export const OPENCLAW_STATE_STRICT_SCHEMA_VERSION = 3;
// Absence records lost history; only Doctor may reconstruct these on existing state.
export const DOCTOR_OWNED_STATE_TABLES = ["agent_deletion_journal"] as const;
// Privacy-sensitive feature tables remain absent even in fresh databases until
// their feature-local first write. The canonical SQL still owns their shape.
export const FIRST_USE_STATE_TABLES = [
  "durable_background_processes",
  "sandbox_persistent_execs",
  "user_profile_identities",
  "user_background_images",
  "local_workspace_projections",
  "local_workspace_manifest_nodes",
  "local_workspace_tree_packs",
  "local_workspace_source_path_sets",
  "update_runs",
  "session_repository_workspaces",
  "github_repository_publication_requests",
  "github_publication_session_lifecycles",
  "skill_library_entries",
  "skill_library_revisions",
  "skill_library_events",
  "skill_library_uploads",
  "github_personal_publication_requests",
  "cron_job_runtime_authorities",
  "cron_run_trigger_state_retirements",
  "execution_identity_contexts",
  "mcp_oauth_pending_authorizations",
  "node_worker_launch_containers",
  "node_worker_launch_boots",
  "node_worker_launch_cleanup",
  "node_worker_launch_process_scopes",
  "node_worker_launches",
  "node_worker_prepared_workspaces",
  "node_worker_turns",
  "operator_approval_execution_identities",
  "operator_approval_standing_grants",
  "operator_approval_standing_grant_generations",
  "web_push_approval_deliveries",
  "execution_decision_facts",
  "execution_owner_lifecycle_bindings",
  "outbound_message_execution_bindings",
  "outbound_message_progress",
] as const;
export const FIRST_USE_STATE_INDEXES = [
  "idx_sandbox_persistent_execs_container",
  "idx_sandbox_persistent_execs_container_name",
  "idx_sandbox_persistent_execs_source",
  "idx_user_profile_identities_profile_id",
  "idx_user_profile_identities_authorization",
  "idx_update_runs_created",
  "idx_update_runs_active",
  "idx_github_repository_publication_shared_request",
  "idx_github_repository_publication_personal_request",
  "idx_github_personal_publication_owner_session",
  "idx_github_personal_publication_pending",
  "idx_node_worker_launches_terminal_completed",
  "idx_node_worker_turns_terminal_completed",
  "idx_node_worker_turns_active_owner",
  "idx_operator_approval_standing_grants_binding",
  "idx_web_push_approval_deliveries_subscription",
  "execution_identity_contexts_run_created_idx",
  "execution_decision_facts_cursor_id_idx",
  "execution_decision_facts_context_occurred_idx",
  "execution_decision_facts_run_occurred_idx",
  "outbound_message_execution_bindings_execution_event_idx",
  "outbound_message_progress_occurred_idx",
  "outbound_message_progress_run_occurred_idx",
] as const;
// These additive tables stay optional until their feature-local lazy ensures
// run; fold them into the next natural schema-version bump.
export const LAZY_ADDITIVE_STATE_TABLES = [
  ...FIRST_USE_STATE_TABLES,
  "agent_provenance",
  "cron_run_receipts",
  "config_revision_keys",
  "secret_store_entries",
  "projects",
  "worktree_templates",
  "user_preferences",
  "device_pair_setup_completions",
  "github_publication_requests",
  "device_pairing_join_codes",
  "skill_workshop_changes",
  "worker_environment_ssh_fallback_ports",
  "worker_session_placement_moves",
] as const;
export const LAZY_ADDITIVE_STATE_INDEXES = [
  ...FIRST_USE_STATE_INDEXES,
  "cron_run_receipts_cursor_id_idx",
  "idx_cron_run_receipts_active_job",
  "idx_cron_run_receipts_job_history",
  "idx_github_publication_requests_pending",
  "secret_store_entries_live_idx",
  "skill_workshop_changes_cursor_id_idx",
  "idx_skill_workshop_changes_agent_time",
] as const;
/** Maximum time one synchronous SQLite call may wait for a lock. */
export const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** User-facing guide for schema refusals; lives here so error sites avoid import cycles. */
export const OPENCLAW_DATABASE_SCHEMA_DOCS_URL =
  "https://docs.openclaw.ai/reference/database-schemas";

/** Open shared SQLite database handle plus WAL maintenance lifecycle. */
export type OpenClawStateDatabase = {
  db: EngineConnection;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};
export type StateDatabaseHandle = Pick<OpenClawStateDatabase, "db" | "path"> &
  Partial<Pick<OpenClawStateDatabase, "walMaintenance">> & {
    afterClose?: () => undefined;
  };
export type OpenClawStateDatabaseCloseOptions = NonNullable<
  Parameters<OpenClawStateDatabase["walMaintenance"]["close"]>[0]
> & { busyTimeoutMs?: number };
export type OpenClawStateDatabaseLifecycleEvent =
  | { kind: "opened"; database: OpenClawStateDatabase; identity: DatabasePathIdentity }
  | { kind: "closed"; path: string; identity: DatabasePathIdentity }
  | { kind: "failure-cleared"; path: string; identity?: DatabasePathIdentity }
  | { kind: "terminal-failure"; path: string; identity?: DatabasePathIdentity; error: Error }
  | { kind: "open-error"; path: string; identity?: DatabasePathIdentity; error: unknown };
/** Options for resolving or overriding the shared state database path. */
export type OpenClawStateDatabaseOptions = {
  env?: NodeJS.ProcessEnv;
  path?: string;
  database?: OpenClawStateDatabase;
  readOnly?: boolean;
  /** Additional known agent stores can only make first-use classification more conservative. */
  initializationAgentPaths?: readonly string[];
};
export const STATE_SCHEMA_MIGRATION_DESCRIPTIONS = {
  "agent-databases-composite-primary-key": "agent database registry primary key → agent_id,path",
  "audit-events-v2": "audit event ledger → versioned message lifecycle schema",
  "commitments-retirement-v7": "retired commitments storage → discarded rows, table, and indexes",
  "worker-placement-execution-mode-v8": "cloud worker placements → execution-mode claims",
  "agent-databases-relative-paths-v9": "agent database registry paths → state-relative storage",
  "state-table-retirement-v10": "retired shared-state tables → removed tables and indexes",
  "state-table-retirement-v11": "retired skill curator tables → removed tables and indexes",
  "singleton-state-foldin-v12": "singleton state tables → shared configuration state",
  "state-consolidation-v13": "cron jobs and subagent runs → canonical JSON storage",
  "creator-namespace-v14": "historical cron creators → unknown source attribution",
  "conversation-binding-targets-v15":
    "conversation bindings → exact target keys without agent/session projections",
  "prepared-worker-ownership-v17":
    "prepared workers → one-use capacity and fixed workspace ownership",
  "github-publication-requester-authority-v18":
    "GitHub publication receipts → original requesting authority",
  "meeting-transcript-start-time": "meeting transcript start dates → persisted milliseconds",
  "portable-identity-columns-v22": "ACP resume keys and receipt cursors → portable columns",
  "task-run-indexes-v24": "retained task indexes → ordered cron history and runtime/run lookup",
  "subagent-operator-recovery-v25": "subagent recovery → original operator authority required",
  "session-state-head-layout-v26": "session state heads → composite primary-key storage",
  "state-write-indexes-v27": "replay, skill usage, and lease writes → smaller index maintenance",
  "github-publication-draft-v28": "GitHub publication requests → durable draft choice",
  "local-client-credentials-v29": "client credentials and native socket material → local owner",
  "predicate-columns-v21": "meeting transcripts and delivery retention → derived predicate columns",
  "automation-policy-fence-v30":
    "Heartbeat monitors → ordinary automation timing and delivery policy fence",
  "local-workspace-manifests-v31":
    "local workspace baselines → per-path manifests and recoverable checkpoint deltas",
  "local-workspace-cas-v35":
    "local workspace baselines → shared immutable trees and compact scan fingerprints",
  "template-names-v36": "starter installs and provenance → canonical Template storage names",
  "operator-approvals-system-agent": "operator approvals → OpenClaw system changes",
  "session-watch-cursor-provenance-v4": "session watch cursors → provenance column",
  "strict-tables-v3": "tables → SQLite STRICT typing",
} as const;

export type OpenClawStateDatabaseSchemaMigration = {
  kind: keyof typeof STATE_SCHEMA_MIGRATION_DESCRIPTIONS;
  path: string;
};
