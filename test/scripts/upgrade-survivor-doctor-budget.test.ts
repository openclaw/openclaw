import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { writePluginInstallIndexForE2E } from "../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const runner = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
const assertIdempotence = runner.slice(
  runner.indexOf("assert_volume_idempotence() {"),
  runner.indexOf("\nvalidate_post_doctor_config() {"),
);
let largeState: string;
let emptyState: string;

function seedState(sessions: number, events: number, cronJobs: number, pluginRoots: number) {
  const root = tempDirs.make("survivor-doctor-state-");
  for (const [relative, tables] of [
    [
      "agents/main/agent/openclaw-agent.sqlite",
      { session_nodes: sessions, transcript_events: events },
    ],
    ["agents/ops/agent/openclaw-agent.sqlite", { session_nodes: 0, transcript_events: 0 }],
    ["state/openclaw.sqlite", { cron_jobs: cronJobs }],
  ] as const) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      for (const [table, count] of Object.entries(tables)) {
        db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
        const insert = db.prepare(`INSERT INTO ${table} (id) VALUES (?)`);
        db.exec("BEGIN");
        for (let index = 0; index < count; index++) {
          insert.run(index);
        }
        db.exec("COMMIT");
      }
    } finally {
      db.close();
    }
  }
  const plugins = Array.from({ length: pluginRoots }, (_, index) => ({
    rootDir: path.join(root, "plugins", String(index)),
    enabled: true,
  }));
  writePluginInstallIndexForE2E(
    {
      plugins: [
        ...plugins,
        ...(plugins[0] ? [plugins[0]] : []),
        { rootDir: path.join(root, "plugins", "disabled"), enabled: false },
      ],
    },
    { stateDir: root },
  );
  return root;
}

beforeAll(() => {
  largeState = seedState(4800, 23890, 2200, 7);
  emptyState = seedState(0, 0, 0, 0);
});

it.each([
  { large: true, elapsed: 473, override: undefined, budget: 676, exit: 0 },
  { large: true, elapsed: 946, override: undefined, budget: 676, exit: 1 },
  { large: false, elapsed: 60, override: "", budget: 60, exit: 0 },
  { large: false, elapsed: 61, override: "", budget: 60, exit: 1 },
  { large: true, elapsed: 690, override: "700", budget: 700, exit: 0 },
])("bounds Doctor using measured state ($large, $elapsed, $override)", (testCase) => {
  const artifacts = tempDirs.make("survivor-doctor-budget-");
  const clock = path.join(artifacts, "clock");
  writeFileSync(clock, "0");
  const result = spawnSync(
    "/bin/bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `source scripts/lib/openclaw-e2e-instance.sh
${assertIdempotence}
# Advance the injected clock when Doctor returns; no real process boot or sleep.
date() { cat "$CLOCK"; }
openclaw_e2e_maybe_timeout() {
  printf '%s\\n' "$*" >"$ARTIFACT_ROOT/doctor-command"
  printf '%s' "$ELAPSED" >"$CLOCK"
}
node() {
  if [ "$2" = assert-state ]; then
    printf 'state-preserved\\n'
  else
    command node "$@"
  fi
}
assert_volume_idempotence
`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        TMPDIR: artifacts,
        GITHUB_ACTIONS: "false",
        OPENCLAW_STATE_DIR: testCase.large ? largeState : emptyState,
        // These deliberately disagree with persisted state and must not select the budget.
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS: "1",
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION: "1",
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_CRON_JOBS: "1",
        ...(testCase.override === undefined
          ? {}
          : { OPENCLAW_UPGRADE_SURVIVOR_VOLUME_IDEMPOTENCE_BUDGET_SECONDS: testCase.override }),
        ARTIFACT_ROOT: artifacts,
        CLOCK: clock,
        ELAPSED: String(testCase.elapsed),
        COMMAND_TIMEOUT: "900s",
        DOCTOR_LOG: path.join(artifacts, "doctor.log"),
        survival_assert_stage: "survival",
      },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(testCase.exit);
  expect(result.stdout).toContain(`(budget ${testCase.budget}s)`);
  expect(readFileSync(path.join(artifacts, "doctor-command"), "utf8")).toBe(
    "900s openclaw doctor --fix --non-interactive\n",
  );
  expect(
    JSON.parse(readFileSync(path.join(artifacts, "volume-doctor-budget.json"), "utf8")),
  ).toEqual({
    counts: testCase.large
      ? { sessions: 4800, events: 23890, cronJobs: 2200, pluginRoots: 7 }
      : { sessions: 0, events: 0, cronJobs: 0, pluginRoots: 0 },
    computedSeconds: testCase.large ? 676 : 60,
    budgetSeconds: testCase.budget,
  });
  if (testCase.exit === 1) {
    expect(result.stderr).toContain(
      `idempotence exceeded budget: ${testCase.elapsed}s > ${testCase.budget}s`,
    );
    expect(result.stdout).not.toContain("state-preserved");
  } else {
    expect(result.stdout).toContain("state-preserved");
  }
});
