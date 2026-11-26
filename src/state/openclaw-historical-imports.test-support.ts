import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

export function frozenSqlSection(sql: string, start: string, end: string): string {
  const left = sql.indexOf(start);
  const right = sql.indexOf(end, left + start.length);
  assert(left >= 0 && right >= 0, `Missing frozen DDL section: ${start} to ${end}`);
  return sql.slice(left, right);
}

export function omitFrozenSqlSection(sql: string, start: string, end: string): string {
  return sql.replace(frozenSqlSection(sql, start, end), "");
}

export function checkedFrozenText(text: string, description: string, sha256: string): string {
  const digest = createHash("sha256").update(text).digest("hex");
  assert.equal(digest, sha256, `Frozen ${description} bytes changed`);
  return text;
}

// Reconstruct the last v19 input before cold storage from the independent v21 fixture.
export function agentV19Schema(): string {
  const sql = fs
    .readFileSync(
      new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v21.sql", import.meta.url),
      "utf8",
    )
    .replace(/^-- Legacy ACP provenance is private import evidence.*\n/mu, "")
    .replace("  legacy_acp_migration_json TEXT,\n", "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_label[^;]*;\n\n/u, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_agent_session_nodes_entry_not_valid[^;]*;\n\n/u, "")
    .replace("  canonical_ready TEXT,\n", "")
    .replace(/\n-- Processing completion is separate from input consumption;[\s\S]*$/u, "");
  return omitFrozenSqlSection(
    omitFrozenSqlSection(
      sql,
      "-- No foreign key: node triggers",
      "CREATE TABLE IF NOT EXISTS conversations (",
    ),
    "CREATE TABLE IF NOT EXISTS session_transcript_cold_archives (",
    "CREATE TABLE IF NOT EXISTS transcript_rewrite_watermarks (",
  );
}

// Keep the historical layout and credential tables independent of current runtime DDL.
export function stateV24Schema(): string {
  let sql = fs.readFileSync(
    new URL("../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
    "utf8",
  );
  sql = omitFrozenSqlSection(
    sql,
    "CREATE TABLE IF NOT EXISTS sandbox_persistent_execs (",
    "CREATE TABLE IF NOT EXISTS cron_jobs (",
  );
  sql = omitFrozenSqlSection(
    sql,
    "-- The projection owner advances changed nodes",
    "-- A reconciliation journal is written before managed-worktree mutation.",
  );
  sql = sql
    .replace(
      /(?=^-- Profile-owned skill library:)/mu,
      `CREATE INDEX IF NOT EXISTS idx_skill_usage_key
  ON skill_usage(skill_key, skill_file);

`,
    )
    .replace(
      "  PRIMARY KEY (session_key, agent_id)\n) STRICT, WITHOUT ROWID;",
      "  PRIMARY KEY (session_key, agent_id)\n) STRICT;",
    )
    .replace("  ON state_leases(owner);", "  ON state_leases(owner, updated_at DESC);")
    .replace(
      /(?=^CREATE TABLE IF NOT EXISTS macos_port_guardian_records \()/mu,
      `CREATE TABLE IF NOT EXISTS device_identities (
  identity_key TEXT NOT NULL PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_device_identities_device
  ON device_identities(device_id, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS device_auth_tokens (
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, role)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_device_auth_tokens_updated
  ON device_auth_tokens(updated_at_ms DESC, device_id, role);

CREATE TABLE IF NOT EXISTS gateway_origin_device_tokens (
  gateway_scope TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (gateway_scope, device_id, role)
) STRICT;

`,
    )
    .replace(
      /(?=^CREATE TABLE IF NOT EXISTS agent_databases \()/mu,
      `CREATE INDEX IF NOT EXISTS idx_acp_replay_events_session_seq
  ON acp_replay_events(session_id, seq);

`,
    )
    .replaceAll("  reported_at_ms INTEGER,\n  draft INTEGER,\n", "  reported_at_ms INTEGER,\n")
    .replace(
      /^ {2}checkpoint_json TEXT,\n[\s\S]*? {2}CHECK \(baseline_json IS NULL OR baseline_ref IS NOT NULL\),/mu,
      "  CHECK ((baseline_json IS NULL) = (baseline_ref IS NULL)),",
    )
    .replace(
      /^ {2}-- Host-scoped verified credit evidence.*\n {2}verified_email_json TEXT,\n/mu,
      "",
    );
  return checkedFrozenText(
    sql,
    "shared state v24",
    "83b19feebda9d8bc613e16751f0b0c18de65a54fd2572f2ca6ddc41e9c0b33e7",
  );
}

// Restore the exact v22 DDL from 1f0deff4a1784c8 using the frozen v24 layout.
export function stateV22Schema() {
  return stateV24Schema()
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

type HistoricalCorpusManifest = {
  release: string;
  variant: string;
  source: string;
  surfaces: Record<string, { expected?: Record<string, unknown> }> & {
    channelPairing: { expected: { request: { code: string } } };
  };
  sidecars: unknown;
  verification: Record<string, Array<{ value: string }>>;
  corruption?: unknown;
};

const STATE_CORPUS_MANIFEST_ROOT = new URL(
  "../../test/fixtures/state-corpus-populated/",
  import.meta.url,
);
const HISTORICAL_CORPUS_MANIFEST_SHA256 = new Map([
  ["2026.7.1", "b179c8492f81109704b1ef3dcf4f046c1c6133d5443221aab4f561603c390b62"],
  ["2026.7.1-blob", "38dd92fe8446c42a9059a567744af6686fb149bb0ba803ef1c26bd0a631702c1"],
  ["2026.7.35", "47c1ad3776f0a655b9f095c528f6a6a0a73f83f6dfb85573db0531e7dbf47b2e"],
  ["2026.8.35", "9f36749348a297f0547c8fee91853c0e352d929b191311eb6fbf98949f40eda3"],
  ["2026.9.37", "0600ea2e9dc1a559efd3fe2af2811918c2f720ac0a6ae9eade1309ccf70d582f"],
  ["2026.10.10", "7c3e9ddd12f8adec0d965cacf60864c0b0446c051a724119dd1652b5eb25ff55"],
]);

function convertedText(converted_values: number, columns_converted: number) {
  return {
    converted_values,
    columns_converted,
    tables_skipped_strict: [],
    tables_skipped_virtual_or_shadow: [],
    errors: [],
    text_values_remaining_non_strict: 0,
  };
}

function restoreArchivedFacts(manifest: HistoricalCorpusManifest, release: string) {
  if (release === "2026.7.1-blob") {
    manifest.variant = "blob";
    manifest.sidecars = [];
    manifest.corruption = {
      description:
        "UPDATE t SET c = CAST(c AS BLOB) WHERE typeof(c)='text' on every column of every non-STRICT, non-virtual, non-FTS-shadow table, after all writers closed (issue #110186)",
      databases: {
        "agents/main/agent/openclaw-agent.sqlite": convertedText(5, 5),
        "agents/ops/agent/openclaw-agent.sqlite": convertedText(5, 5),
        "state/openclaw.sqlite": convertedText(129, 97),
      },
    };
    return;
  }

  const { surfaces, verification } = manifest;
  manifest.release = "2026.7.35";
  manifest.source = "0af2921e9a264759eb5c7e5781739733a2a0458d";
  surfaces.sessions!.expected!.sessionUpdatedAt = 1794580856419;
  surfaces.deviceIdentity!.expected!.deviceId =
    "a0a4af6a0cff536d1433f6f31c26212f68d9149080c44347533159400d1537ad";
  surfaces.devicePairingRequest!.expected!.requestId = "b88e15e9-3f19-4e03-ab2f-c236eb0bea12";
  surfaces.deliveryQueue!.expected!.id = "c18ede3c-ad67-4cdc-a295-91542ce2bd5b";
  surfaces.webPushSubscription!.expected!.subscriptionId = "a3f75702-4a2a-4af1-85da-90acc3357055";
  surfaces.taskRun!.expected!.taskId = "42cd1fec-114d-415d-b260-9cacac392401";
  surfaces.channelPairing.expected.request.code = "78VUXM33";
  verification.deviceIdentity![0]!.value = String(surfaces.deviceIdentity!.expected!.deviceId);
}

export function readHistoricalStateCorpusManifest(release: string): string {
  const source = release === "2026.7.1-blob" || release === "2026.7.35" ? "2026.7.1" : release;
  const bytes = fs.readFileSync(
    new URL(source + "/manifest.json", STATE_CORPUS_MANIFEST_ROOT),
    "utf8",
  );
  const sha256 = HISTORICAL_CORPUS_MANIFEST_SHA256.get(source);
  if (sha256) {
    checkedFrozenText(bytes, "manifest anchor " + source, sha256);
  }
  if (source === release) {
    return bytes;
  }

  // The anchor hash fixes retained provenance and values before historical edits.
  const manifest = JSON.parse(bytes) as HistoricalCorpusManifest;
  restoreArchivedFacts(manifest, release);
  return checkedFrozenText(
    JSON.stringify(manifest, null, 2) + "\n",
    "reconstructed manifest " + release,
    HISTORICAL_CORPUS_MANIFEST_SHA256.get(release)!,
  );
}
