import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/upgrade-survivor/cron-owner-doctor.mjs");

function fixture(candidateProjection = false, baselineVersion = "2026.9.4") {
  const runtime = tempDirs.make("cron-owner-published-fixture-");
  const state = path.join(runtime, "state");
  const artifacts = path.join(runtime, "artifacts");
  mkdirSync(path.join(state, "state"), { recursive: true });
  mkdirSync(artifacts);
  const configPath = path.join(state, "openclaw.json");
  const config = JSON.stringify({
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    cron: { enabled: false },
  });
  writeFileSync(configPath, config);
  writeFileSync(
    path.join(artifacts, "baseline-package-identity.json"),
    JSON.stringify({
      version: baselineVersion,
      buildInfo: { commit: "3a9d69db306cd7f081e06254cb89c4bcc14a7107" },
    }),
  );
  writeFileSync(
    path.join(artifacts, "candidate-package-identity.json"),
    JSON.stringify({ version: "2026.9.6", buildInfo: { commit: "a".repeat(40) } }),
  );
  const databasePath = path.join(state, "state/openclaw.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    // Exact released 9.4 table: the fixture must not depend on candidate grant columns.
    db.exec(`CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL, declaration_key TEXT, owner_agent_id TEXT,
      name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL, agent_id TEXT,
      payload_kind TEXT NOT NULL, job_json TEXT NOT NULL, state_json TEXT NOT NULL DEFAULT '{}',
      runtime_updated_at_ms INTEGER, schedule_identity TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (store_key, job_id)
    ) STRICT`);
    if (candidateProjection) {
      db.exec("ALTER TABLE cron_jobs ADD COLUMN grant_definition_generation INTEGER");
    }
  } finally {
    db.close();
  }
  return { runtime, state, artifacts, configPath, databasePath, config };
}

it.each([
  { baselineVersion: "2026.9.4", candidateProjection: false },
  { baselineVersion: "2026.9.4", candidateProjection: true },
  { baselineVersion: "2026.9.7", candidateProjection: true },
])(
  "seeds published $baselineVersion with candidate projection=$candidateProjection only when supported",
  ({ baselineVersion, candidateProjection }) => {
    const f = fixture(candidateProjection, baselineVersion);
    const result = spawnSync(resolveTestNodeExecPath(), [helper, "seed"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: f.state,
        OPENCLAW_CONFIG_PATH: f.configPath,
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: f.runtime,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: f.artifacts,
      },
    });
    const db = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      if (candidateProjection && baselineVersion === "2026.9.4") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Baseline already contains candidate grant projections");
        expect(readFileSync(f.configPath, "utf8")).toBe(f.config);
        expect(db.prepare("SELECT count(*) AS count FROM cron_jobs").get()?.count).toBe(0);
        return;
      }
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const rows = db
        .prepare("SELECT job_id, agent_id, job_json FROM cron_jobs ORDER BY sort_order")
        .all();
      expect(rows.map((row) => [row.job_id, row.agent_id])).toEqual([
        ["owner-proof-historical", null],
        ["owner-proof-explicit", "research"],
        ["owner-proof-session", null],
        ["owner-proof-sql-owner", "research"],
        ["owner-proof-delivery-missing", "ops"],
        ["owner-proof-delivery-null", "ops"],
        ["owner-proof-delivery-alias", "ops"],
        ["owner-proof-delivery-announce-case", "ops"],
        ["owner-proof-delivery-none-case", "ops"],
        ["owner-proof-delivery-webhook-case", "ops"],
      ]);
      expect(JSON.parse(String(rows[0]?.job_json))).not.toHaveProperty("agentId");
      expect(JSON.parse(String(rows[2]?.job_json))).toHaveProperty(
        "sessionKey",
        "agent:research:main",
      );
      expect(JSON.parse(String(rows[3]?.job_json))).not.toHaveProperty("agentId");
      const deliveries = rows.slice(4).map((row) => JSON.parse(String(row.job_json)).delivery);
      expect(deliveries).toEqual([
        { channel: "telegram", to: "synthetic-target" },
        { mode: null, channel: "telegram", to: "synthetic-target" },
        { mode: "deliver", channel: "telegram", to: "synthetic-target" },
        { mode: " ANNOUNCE ", channel: "telegram", to: "synthetic-target" },
        { mode: " NoNe " },
        { mode: " WeBhOoK ", to: "https://example.invalid/cron" },
      ]);
      const saved = JSON.parse(readFileSync(f.configPath, "utf8"));
      expect(saved.agents).not.toHaveProperty("ownership");
      expect(saved.agents.entries.ops.default).toBe(true);
      const legacy = JSON.parse(readFileSync(saved.cron.store, "utf8"));
      expect(legacy.jobs).toHaveLength(1);
      expect(legacy.jobs[0].id).toBe("owner-proof-json-import");
      expect(legacy.jobs[0]).not.toHaveProperty("agentId");
    } finally {
      db.close();
    }
  },
);

describe.skipIf(process.platform === "win32")("registered cron-owner upgrade ordering", () => {
  it.each([false, true])(
    "keeps first assertions ahead of standalone candidate commands (assertion failure=%s)",
    (failAssertion) => {
      const root = tempDirs.make("cron-owner-driver-order-");
      const events = path.join(root, "events");
      writeFileSync(events, "");
      const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
      const start = source.indexOf('\nif [ "$SCENARIO" = "cron-owner-doctor" ]; then\n');
      const end = source.indexOf('\nif [ "$SCENARIO" = "dreaming-cron-doctor" ]; then\n', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `set -eu
SCENARIO=cron-owner-doctor
baseline_version=2026.9.7
ARTIFACT_ROOT="$UNIT_ROOT"
BASELINE_DOCTOR_LOG="$UNIT_ROOT/baseline.log"
DOCTOR_LOG="$UNIT_ROOT/doctor.log"
COMMAND_TIMEOUT=900s
CANDIDATE_SPEC="$UNIT_ROOT/candidate.tgz"
last_update_observation_root="$UNIT_ROOT/observations"
package_root() { printf '%s\\n' "$UNIT_ROOT/package"; }
phase() {
  printf '%s\\n' "$1" >> "$UNIT_ROOT/events"
  if [ "$1" = assert-cron-owner-update ] && [ "$UNIT_FAIL_ASSERTION" = 1 ]; then return 42; fi
}
${source.slice(start, end)}
`,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, UNIT_ROOT: root, UNIT_FAIL_ASSERTION: failAssertion ? "1" : "0" },
        },
      );
      const phases = readFileSync(events, "utf8").trim().split("\n");
      const before = (first: string, second: string) => {
        expect(phases.indexOf(first)).toBeGreaterThanOrEqual(0);
        expect(phases.indexOf(second)).toBeGreaterThan(phases.indexOf(first));
      };
      before("seed-cron-owner-session", "cron-owner-baseline-gateway-stop");
      before("cron-owner-baseline-gateway-stop", "seed-cron-owner-state");
      before("seed-cron-owner-state", "backup-cron-owner-state");
      before("backup-cron-owner-state", "update-cron-owner-candidate");
      before("update-cron-owner-candidate", "assert-cron-owner-update");
      if (failAssertion) {
        expect(result.status).toBe(42);
        expect(phases).not.toContain("cron-owner-repeat-doctor");
        expect(phases).not.toContain("cron-owner-candidate-gateway-start");
        expect(result.stdout).not.toContain("Cron ownership survived");
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        before("assert-cron-owner-update", "cron-owner-repeat-doctor");
        before("assert-cron-owner-idempotence", "cron-owner-candidate-gateway-start");
        before("cron-owner-candidate-gateway-stop", "assert-cron-owner-runtime");
      }
    },
  );
});
