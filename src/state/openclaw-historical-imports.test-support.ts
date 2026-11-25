import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const preparation = {
  key: "a".repeat(64),
  cacheKey: "c".repeat(64),
  contractVersion: 1,
  target: { machineClass: "small", platform: "linux" },
  artifacts: {
    nodeBootstrapSha256: "d".repeat(64),
    enabledPluginIds: [],
    workerBundleHash: "e".repeat(64),
    workerArchiveSha256: "f".repeat(64),
    openclawVersion: "synthetic",
    protocolFeatures: [],
  },
};
export const original = JSON.stringify({
  install: "bundle",
  settings: { provider: "synthetic" },
  project: { kind: "image", key: "b".repeat(64), preparation },
});

// Restore the exact v22 DDL from 1f0deff4a1784c8 using the existing frozen v24 fixture.
export function stateV22Schema() {
  return fs
    .readFileSync(
      new URL("../../test/fixtures/sqlite/openclaw-state-schema-v24.sql", import.meta.url),
      "utf8",
    )
    .replace(
      /CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_run[\s\S]*?(?=CREATE TABLE IF NOT EXISTS subagent_runs)/u,
      [
        "CREATE INDEX IF NOT EXISTS idx_task_runs_run_id ON task_runs(run_id);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_status ON task_runs(runtime, status);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup_after ON task_runs(cleanup_after);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_last_event_at ON task_runs(last_event_at);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_owner_key ON task_runs(owner_key);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_parent_flow_id ON task_runs(parent_flow_id);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_child_session_key ON task_runs(child_session_key);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_requester_session_key ON task_runs(requester_session_key);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_source_ended",
        "  ON task_runs(runtime, source_id, ended_at, created_at, task_id);",
        "CREATE INDEX IF NOT EXISTS idx_task_runs_runtime_ended",
        "  ON task_runs(runtime, ended_at, created_at, task_id);",
        "",
        "",
      ].join("\n"),
    )
    .replace("  started_at_ms INTEGER,\n", "")
    .replace(
      /CREATE INDEX IF NOT EXISTS idx_meeting_transcript_sessions_chronology[^;]*;\n\n/u,
      "",
    );
}

// v21 cursor/ACP definitions precede 1f0deff4a1784c8. The imported branch also
// retained JSON predicates and the frozen repository-preparation placement contract.
export function stateV21Schema() {
  const whitespace =
    "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
  const originalPlacement = fs.readFileSync(
    new URL("./openclaw-state-teamclaw-placement.test-fixture.sql", import.meta.url),
    "utf8",
  );
  return stateV22Schema()
    .replaceAll("  cursor_id INTEGER NOT NULL,\n", "")
    .replace(
      /CREATE UNIQUE INDEX IF NOT EXISTS (?:skill_workshop_changes_cursor_id_idx|execution_decision_facts_cursor_id_idx|idx_operator_approvals_cursor_id|cron_run_receipts_cursor_id_idx)[^;]*;\n\n/gu,
      "",
    )
    .replace(/ {2}resume_(?:agent|acpx)_session_id TEXT,\n/gu, "")
    .replace(
      "ON acp_sessions(resume_agent_session_id)",
      "ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.agentSessionId'), " +
        whitespace +
        "))",
    )
    .replace(
      "ON acp_sessions(resume_acpx_session_id)",
      "ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.acpxSessionId'), " +
        whitespace +
        "))",
    )
    .replace(
      / {2}(?:source_account_id|source_guild_id|source_channel_id|source_meeting_url|source_thread_ts|source_file_id|metadata_agent_id|overview) TEXT,\n/gu,
      "",
    )
    .replace(/ {2}retention_(?:id_prefix TEXT|max_age_ms INTEGER|max_entries INTEGER),\n/gu, "")
    .replace(
      /CREATE INDEX IF NOT EXISTS (?:idx_meeting_transcript_sessions_source|idx_meeting_transcript_sessions_account|idx_meeting_transcript_sessions_agent|idx_delivery_queue_bounded_retention)[^;]*;\n\n/gu,
      "",
    )
    .replace(
      /CREATE TABLE IF NOT EXISTS worker_session_placements \([\s\S]*?\n\) STRICT;/u,
      originalPlacement,
    );
}

export function seedHistoricalPlacements(db: DatabaseSync) {
  const insert = db.prepare(
    "INSERT INTO worker_session_placements " +
      "(session_id,agent_id,session_key,execution_mode,state,environment_id,transition_generation," +
      "active_owner_epoch,workspace_base_manifest_ref,repository_preparation,remote_workspace_dir," +
      "worker_bundle_hash,created_at_ms,updated_at_ms,state_changed_at_ms) " +
      "VALUES (?,'main',?,'worker-turn','active','historical-image',7,3,?,?,'/repo','bundle',1,2,2)",
  );
  insert.run("placement-ready", "agent:main:ready", "manifest", "ready");
  insert.run("placement-pending", "agent:main:pending", null, "pending");
  db.exec(
    "CREATE INDEX historical_placement_epoch ON worker_session_placements(active_owner_epoch);" +
      "UPDATE worker_session_placements SET turn_claim_owner='worker', turn_claim_id='claim-ready', " +
      "turn_claim_run_id='run-ready',turn_claim_generation=7,turn_claim_owner_epoch=3 WHERE session_id='placement-ready';",
  );
  return db.prepare("SELECT * FROM worker_session_placements ORDER BY session_id").all();
}
