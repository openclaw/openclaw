import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("carries the allocated Docker budget into repair progress without resetting earlier deadlines", () => {
  const root = dirs.make("repair-progress-budget-");
  const bin = path.join(root, "bin");
  const receipt = path.join(root, "receipt.json");
  const registry = path.join(root, "registry");
  fs.mkdirSync(registry);
  fs.writeFileSync(
    path.join(registry, "prepublish-plugin-registry.json"),
    JSON.stringify({ sourceSha: "a".repeat(40), candidateVersion: "2026.9.8", packages: [] }),
  );
  const candidate = path.join(root, "candidate.tgz");
  fs.mkdirSync(bin);
  fs.writeFileSync(candidate, "unused by the Docker boundary fixture");
  const executable = (name: string, source: string) =>
    fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 });
  executable(
    "date",
    `#!/bin/sh
echo 1000
`,
  );
  executable(
    "node",
    `#!` +
      process.execPath +
      `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
if (process.argv[2]?.endsWith("/upgrade-survivor/published-driver.mjs")) {
  const record = JSON.parse(fs.readFileSync(process.env.RECEIPT));
  record.deadline = Number(process.env.CELL_DEADLINE_EPOCH_SECONDS);
  fs.writeFileSync(process.env.RECEIPT, JSON.stringify(record));
} else {
  const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
  );
  executable(
    "docker",
    `#!` +
      process.execPath +
      `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "run") process.exit(0);
const env = { PATH: process.env.PATH, HOME: process.env.HOME, RECEIPT: process.env.RECEIPT };
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "-e") continue;
  const value = args[++i], equal = value.indexOf("=");
  if (equal >= 0) env[value.slice(0, equal)] = value.slice(equal + 1);
  else if (process.env[value] !== undefined) env[value] = process.env[value];
}
const runner = args.find(value => value.endsWith(":/tmp/openclaw-upgrade-survivor-run.sh:ro"));
const timeout = args[args.lastIndexOf("timeout") + 2];
fs.writeFileSync(process.env.RECEIPT, JSON.stringify({ timeout, inherited: env.CELL_DEADLINE_EPOCH_SECONDS }));
if (env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO === "repair-progress") {
  const result = spawnSync("bash", [runner.split(":")[0]], { env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
  );
  const lane = mainLanes.find((entry) => entry.name === "published-upgrade-survivor")!;
  const cases = [
    { scenario: "repair-progress", planned: true, deadline: undefined, expected: 3205 },
    { scenario: "repair-progress", planned: true, deadline: "1500", expected: 1500 },
    { scenario: "repair-progress", planned: true, deadline: "999", expected: 999 },
    { scenario: "repair-progress", planned: true, deadline: "9999", expected: 3205 },
    { scenario: "repair-progress", planned: false, deadline: undefined, expected: 2125 },
    { scenario: "base", planned: true, deadline: "1500", expected: undefined },
  ];
  for (const entry of cases) {
    fs.rmSync(receipt, { force: true });
    const result = spawnSync(
      "bash",
      [
        "-c",
        entry.planned
          ? lane.command
          : 'bash "$OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR/scripts/e2e/upgrade-survivor-docker.sh"',
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: bin + path.delimiter + process.env.PATH,
          HOME: root,
          TMPDIR: root,
          RECEIPT: receipt,
          CELL_DEADLINE_EPOCH_SECONDS: entry.deadline,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          OPENCLAW_CURRENT_PACKAGE_TGZ: candidate,
          OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: process.cwd(),
          OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR: process.cwd(),
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: path.join(root, "artifacts"),
          OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.9.7",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: entry.scenario,
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const record = JSON.parse(fs.readFileSync(receipt, "utf8"));
    expect(record.timeout).toBe(entry.planned ? "2280s" : "1200s");
    expect(record.deadline).toBe(entry.expected);
    if (entry.scenario === "base") {
      expect(record.inherited).toBeUndefined();
    }
    if (entry.planned && entry.deadline === undefined) {
      // Run 37762967525: two updates budgeted at the observed first-update cost,
      // two measured repairs, plus 150s for setup/identity/relabel. No clock waits.
      const workSeconds = record.deadline - 1000 - 60;
      const measuredComposition = 2 * 638.177 + 81.681 + 79.589 + 150;
      expect(workSeconds).toBeGreaterThan(measuredComposition * 1.3);
      expect(lane.timeoutMs! / 1000 - 2280).toBeGreaterThanOrEqual(300);
    }
  }
});
