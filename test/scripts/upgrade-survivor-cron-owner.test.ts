import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/upgrade-survivor/cron-owner-doctor.mjs");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

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
  for (const [kind, version, commit] of [
    ["baseline", baselineVersion, "3a9d69db306cd7f081e06254cb89c4bcc14a7107"],
    ["candidate", "2026.9.6", "a".repeat(40)],
  ]) {
    writeJson(path.join(artifacts, `${kind}-package-identity.json`), {
      version,
      buildInfo: { commit },
    });
  }
  const databasePath = path.join(state, "state/openclaw.sqlite");
  using db = new DatabaseSync(databasePath);
  // Exact released 9.4 table: the fixture must not depend on candidate grant columns.
  db.exec(`CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL, declaration_key TEXT, owner_agent_id TEXT,
      name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL, agent_id TEXT,
      payload_kind TEXT NOT NULL, job_json TEXT NOT NULL, state_json TEXT NOT NULL DEFAULT '{}',
      runtime_updated_at_ms INTEGER, schedule_identity TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (store_key, job_id)
    ) STRICT`);
  db.exec(`CREATE TABLE diagnostic_events (
      scope TEXT NOT NULL, event_key TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, event_key)
    ) STRICT`);
  if (candidateProjection) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN grant_definition_generation INTEGER");
  }
  return { runtime, state, artifacts, configPath, databasePath, config };
}

it.each([
  ["2026.9.4", false],
  ["2026.9.4", true],
  ["2026.9.7", true],
] as const)(
  "seeds published %s with candidate projection=%s only when supported",
  (baselineVersion, candidateProjection) => {
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
    using db = new DatabaseSync(f.databasePath, { readOnly: true });
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
      ...["missing", "null", "alias", "announce-case", "none-case", "webhook-case"].map((name) => [
        `owner-proof-delivery-${name}`,
        "ops",
      ]),
    ]);
    expect(JSON.parse(String(rows[0]?.job_json))).not.toHaveProperty("agentId");
    expect(JSON.parse(String(rows[2]?.job_json))).toHaveProperty(
      "sessionKey",
      "agent:research:main",
    );
    expect(JSON.parse(String(rows[3]?.job_json))).not.toHaveProperty("agentId");
    const deliveries = rows.slice(4).map((row) => JSON.parse(String(row.job_json)).delivery);
    expect(deliveries).toEqual([
      ...[undefined, null, "deliver", " ANNOUNCE "].map((mode) =>
        Object.assign(
          { channel: "telegram", to: "synthetic-target" },
          mode === undefined ? {} : { mode },
        ),
      ),
      { mode: " NoNe " },
      { mode: " WeBhOoK ", to: "https://example.invalid/cron" },
    ]);
    const saved = readJson(f.configPath);
    expect(saved.agents).not.toHaveProperty("ownership");
    expect(saved.agents.entries.ops.default).toBe(true);
    expect(existsSync(saved.cron.store)).toBe(false);
    const specimen = readJson(path.join(f.artifacts, "cron-owner-fixture.json"));
    expect(specimen.definitions).toHaveLength(rows.length);
    expect(specimen.before).toMatchObject({ legacySourceSha256: null, quarantinedJobs: 0 });
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
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
  if [ "$1" = cron-owner-candidate-startup ]; then printf '%s\\n' "$@" > "$UNIT_ROOT/startup-arguments"; fi
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
    const ordered = (...names: string[]) => {
      names.forEach((name, index) => {
        const previous = names[index - 1];
        expect(phases.indexOf(name)).toBeGreaterThanOrEqual(0);
        expect(phases.indexOf(name)).toBeGreaterThan(
          previous === undefined ? -1 : phases.indexOf(previous),
        );
      });
    };
    ordered(
      "seed-cron-owner-session",
      "cron-owner-baseline-gateway-stop",
      "seed-cron-owner-state",
      "backup-cron-owner-state",
      "update-cron-owner-candidate",
      "assert-cron-owner-update",
    );
    if (failAssertion) {
      expect(result.status).toBe(42);
      expect(phases).not.toContain("cron-owner-repeat-doctor");
      expect(phases).not.toContain("cron-owner-candidate-gateway-start");
      expect(result.stdout).not.toContain("Cron ownership survived");
    } else {
      expect(result.status, result.stdout + result.stderr).toBe(0);
      ordered("assert-cron-owner-update", "cron-owner-repeat-doctor");
      ordered(
        "assert-cron-owner-idempotence",
        "cron-owner-candidate-gateway-start",
        "cron-owner-candidate-startup",
        "run-cron-owner-runtime",
      );
      expect(readFileSync(path.join(root, "startup-arguments"), "utf8").trim().split("\n")).toEqual(
        [
          "cron-owner-candidate-startup",
          "probe_gateway_endpoint",
          "/startupz",
          "started",
          path.join(root, "cron-owner-startup.json"),
        ],
      );
      ordered("cron-owner-candidate-gateway-stop", "assert-cron-owner-runtime");
    }
  },
);
