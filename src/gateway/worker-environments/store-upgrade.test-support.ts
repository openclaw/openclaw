import type { DatabaseSync } from "node:sqlite";
import { ensureSessionRepositoryWorkspaceSchema } from "../../state/openclaw-state-db-schema-additive.js";

export function seedWorkerUpgradeState(database: DatabaseSync, environmentId: string): void {
  ensureSessionRepositoryWorkspaceSchema(database);
  database
    .prepare(`INSERT INTO session_repository_workspaces (
        workspace_id, agent_id, session_key, url, base_commit, base_manifest_hash,
        branch, checkpoint_ref, manifest_hash, revision, created_at_ms, updated_at_ms
      ) VALUES (?, 'main', 'agent:main:retained', 'https://github.com/example/retained', ?, ?,
        'retained-work', 'refs/openclaw/worker-results/retained-checkpoint', ?, 26, 1, 2)`)
    .run(
      "12345678-1234-1234-1234-123456789abc",
      "a".repeat(40),
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
    );
  database
    .prepare(`INSERT INTO worker_session_placements (
        session_id, agent_id, session_key, state, environment_id, transition_generation,
        created_at_ms, updated_at_ms, state_changed_at_ms, recovery_error
      ) VALUES ('retained-session', 'main', 'agent:main:retained', 'failed', ?, 56, 1, 2, 2, 'node disconnected')`)
    .run(environmentId);
}

export function readWorkerUpgradeState(database: DatabaseSync, doctorMaintenance = false) {
  return {
    workers: database.prepare("SELECT * FROM worker_environments").all(),
    credentials: database.prepare("SELECT * FROM worker_environment_credentials").all(),
    attachments: database.prepare("SELECT * FROM worker_environment_session_attachments").all(),
    placements: database.prepare("SELECT * FROM worker_session_placements").all(),
    checkpoints: database.prepare("SELECT * FROM session_repository_workspaces").all(),
    // Full Doctor refreshes its maintenance timestamp even for a same-version repair.
    metadata: database
      .prepare(
        doctorMaintenance
          ? "SELECT meta_key, role, schema_version, agent_id, app_version, created_at FROM schema_meta"
          : "SELECT * FROM schema_meta",
      )
      .all(),
    version: database.prepare("PRAGMA user_version").get(),
  };
}
