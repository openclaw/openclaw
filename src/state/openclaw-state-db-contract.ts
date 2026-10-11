import type { DatabaseSync } from "node:sqlite";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";

export type OpenClawStateSchemaReadAdmission = (database: DatabaseSync) => (() => void) | undefined;

// v21 fences ordinary automation timing and delivery policies from older schedulers.
// v20 fences possibly delivered cron completions across restart recovery.
// v19 preserves original channel-owner authorization across recovery.
// v18 binds shared GitHub publication to its original requesting authority.
// v17 records one-use prepared worker capacity and node workspace ownership.
// v16 makes Skill Workshop ownership directory-based instead of row-provenance-based.
// v15 removes redundant agent/session projections from conversation bindings.
// v14 retains unknown creator namespaces on historical cron jobs.
// v13 keeps cron jobs and subagent runs canonical in JSON, removing unused projections.
// v12 folds singleton state into config_machine_state and retires write-only cron epochs.
// v11 retires the legacy skill curator lifecycle and write-only proposal origin runs.
// v10 retires six dead tables that shipped without runtime owners.
// v9 stores in-root agent database registry paths relative to the state dir.
// v8 records cloud-placement execution mode and mode-aware turn claims.
// v7 retires the inert shared commitments table.
// v6 makes every committed shared-state table part of the canonical runtime schema.
// v5 records durable cloud-worker result refs on pending workspace fences.
export const OPENCLAW_STATE_SCHEMA_VERSION = 21;
export const OPENCLAW_STATE_STRICT_SCHEMA_VERSION = 3;
// Absence records lost history; only Doctor may reconstruct these on existing state.
export const DOCTOR_OWNED_STATE_TABLES = ["agent_deletion_journal"] as const;
// Privacy-sensitive feature tables remain absent even in fresh databases until
// their feature-local first write. The canonical SQL still owns their shape.
export const FIRST_USE_STATE_TABLES = [
  "user_profile_identities",
  "user_background_images",
  "local_workspace_projections",
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
  "idx_cron_run_receipts_active_job",
  "idx_cron_run_receipts_job_history",
  "idx_github_publication_requests_pending",
  "secret_store_entries_live_idx",
  "idx_skill_workshop_changes_agent_time",
] as const;
/** Maximum time one synchronous SQLite call may wait for a lock. */
export const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** User-facing guide for schema refusals; lives here so error sites avoid import cycles. */
export const OPENCLAW_DATABASE_SCHEMA_DOCS_URL =
  "https://docs.openclaw.ai/reference/database-schemas";

/** Open shared SQLite database handle plus WAL maintenance lifecycle. */
export type OpenClawStateDatabase = {
  db: DatabaseSync;
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
  "automation-policy-fence-v21":
    "Heartbeat monitors → ordinary automation timing and delivery policy fence",
  "operator-approvals-system-agent": "operator approvals → OpenClaw system changes",
  "session-watch-cursor-provenance-v4": "session watch cursors → provenance column",
  "strict-tables-v3": "tables → SQLite STRICT typing",
} as const;

export type OpenClawStateDatabaseSchemaMigration = {
  kind: keyof typeof STATE_SCHEMA_MIGRATION_DESCRIPTIONS;
  path: string;
};
