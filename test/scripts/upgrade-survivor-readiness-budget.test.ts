import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseTimeoutMs } from "../../scripts/lib/docker-e2e-watchdog.mjs";
import { REPAIR_READINESS_BUDGET } from "../../scripts/lib/upgrade-survivor-policy.mjs";
import { planTargetedDockerLaneGroups } from "../../scripts/plan-targeted-docker-lane-groups.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);

it("fits measured work and retains every outer reserve for both exact driver jobs", () => {
  const workSeconds = REPAIR_READINESS_BUDGET.dockerSeconds - 75 - 60;
  expect(workSeconds).toBe(3285);
  expect(workSeconds).toBeGreaterThan(2 * (638.177 + 185) + 3 * 300 + 360);
  expect(REPAIR_READINESS_BUDGET.laneSeconds - REPAIR_READINESS_BUDGET.dockerSeconds).toBe(300);
  const groups = planTargetedDockerLaneGroups({
    lanes: "published-upgrade-survivor",
    upgradeSurvivorBaselines: "openclaw@2026.9.7 openclaw@2026.9.8",
    upgradeSurvivorScenarios: "repair-readiness",
  });
  expect(groups).toHaveLength(2);
  expect(groups.map((group) => group.timeout_minutes)).toEqual([90, 90]);
  expect(90 * 60 - REPAIR_READINESS_BUDGET.laneSeconds).toBe(1680);
});

it("retains the existing watchdog duration grammar without running timers", () => {
  for (const timeout of ["3420s", "57m", "0.95h", "3420000ms", "3420"]) {
    expect(parseTimeoutMs(timeout)).toBe(3_420_000);
  }
  expect(parseTimeoutMs("0")).toBe(1);
  expect(() => parseTimeoutMs("forever")).toThrow();
});

it("propagates the real host deadline into Docker arguments and the inner entry without renewal", () => {
  const root = dirs.make("readiness-budget-shell-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Only replace the final app launch. The host's actual Node budget adapter
  // runs with a fixed shell clock, without Docker, sleeps, or live timers.
  writeFileSync(
    join(bin, "node"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$CELL_DEADLINE_EPOCH_SECONDS" "$@"\n',
    { mode: 0o755 },
  );
  const source = readFileSync("scripts/e2e/upgrade-survivor-docker.sh", "utf8");
  const start = source.indexOf('  if [ "$SCENARIO" = "repair-readiness" ]; then\n    # Establish');
  expect(start).toBeGreaterThan(0);
  const block = source.slice(
    start,
    source.indexOf('  echo "Running published upgrade survivor Docker E2E..."', start),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    FIXTURE_NODE: resolveTestNodeExecPath(),
    OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: "/fixture/package.tgz",
    OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.9.7",
  };
  delete env.CELL_DEADLINE_EPOCH_SECONDS;
  const entry = resolve("scripts/e2e/lib/upgrade-survivor/repair-readiness.sh");
  const shell =
    'set -euo pipefail; SCENARIO=repair-readiness; HARNESS_ROOT_DIR="$1"; DOCKER_RUN_TIMEOUT="$3"; CELL_DEADLINE_EPOCH_SECONDS="$4"; UPGRADE_SCENARIO_ARGS=(); date() { printf 1000; }; node() { "$FIXTURE_NODE" "$@"; };\n' +
    block +
    '\nexport "' +
    "${UPGRADE_SCENARIO_ARGS[1]}" +
    '"; bash "$2"';
  const validCases: Array<[timeout: string, inherited: string, expected: string]> = [
    ["3420s", "", "4345"],
    ["57m", "", "4345"],
    ["20m", "", "2125"],
    ["3420s", "3000", "3000"],
    ["3420s", "9999", "4345"],
    ["3420s", "900", "900"],
  ];
  for (const [timeout, inherited, expected] of validCases) {
    const result = spawnSync(
      "bash",
      ["-c", shell, "fixture", process.cwd(), entry, timeout, inherited],
      { env, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      expected,
      "/tmp/openclaw-release-harness/scripts/e2e/lib/upgrade-survivor/published-driver.mjs",
      "/fixture/package.tgz",
      "/tmp/openclaw-upgrade-survivor-artifacts",
      "2026.9.7",
      "repair-readiness",
    ]);
  }
  const invalidCases: Array<[timeout: string, inherited: string]> = [
    ["135s", ""],
    ["3420s", "0"],
    ["3420s", "invalid"],
    ["forever", ""],
  ];
  for (const [timeout, inherited] of invalidCases) {
    const refused = spawnSync(
      "bash",
      ["-c", shell, "fixture", process.cwd(), entry, timeout, inherited],
      { env, encoding: "utf8", timeout: 5000 },
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toBe("");
  }
  const missing = spawnSync("bash", [entry], { env, encoding: "utf8", timeout: 5000 });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("caller-owned absolute deadline");
});
