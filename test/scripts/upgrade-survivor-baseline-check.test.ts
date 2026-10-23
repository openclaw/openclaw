import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as io from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scenarios = ["legacy-operator-state", "base"];
const read = (file: string) => readFileSync(file, "utf8");
type Install = { args: string[]; prefix: string };
const baseline = (version: number, status: string) => ({
  baseline: `openclaw@2026.8.${version}`,
  status,
  scenarios,
});

function runFixture(
  failure: "version" | "runtime" | "install" | "launch",
  overrides: NodeJS.ProcessEnv = {},
) {
  const root = tempDirs.make("survivor-precheck-");
  const evidence = path.join(root, "evidence");
  const installs = path.join(root, "installs.jsonl");
  io.writeExecutable(
    path.join(root, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
const spec = args.find(arg => arg.startsWith("openclaw@"));
fs.appendFileSync(${JSON.stringify(installs)}, JSON.stringify({ args, prefix }) + "\\n");
if (${JSON.stringify(failure)} === "install" && spec.endsWith("8.33")) {
  console.error("registry unavailable"); process.exit(1);
}
if (${JSON.stringify(failure)} === "launch" && spec.endsWith("8.33")) process.exit(0);
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
fs.writeFileSync(path.join(prefix, "bin", "openclaw"), '#!/usr/bin/env node\\n' +
  'if (' + JSON.stringify(spec.endsWith("8.33")) + ' && process.argv.includes(' +
  JSON.stringify(${JSON.stringify(failure)} === "version" ? "--version" : "set") +
  ')) { console.error("Cannot find package fixture-runtime"); process.exit(1); }\\n' +
  'console.log(process.argv.includes("--version") ? ' + JSON.stringify(spec) + ' : "local");\\n',
  { mode: 0o755 });
`,
  );
  const result = io.runProcess(
    process.execPath,
    ["scripts/plan-targeted-docker-lane-groups.mjs", "--check-baselines", evidence],
    {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      LANES: "published-upgrade-survivor onboard",
      GROUP_SIZE: "1",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "2026.8.33 2026.8.34",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.8.33",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SCOPE: "all-scenarios",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "legacy-operator-state base",
      ...overrides,
    },
  );
  return {
    result,
    evidence,
    installs,
    report: io.readJson(path.join(evidence, "summary.json")),
  };
}

it("checks each pinned recovery driver once before scheduling exact rows", () => {
  const fixture = runFixture("runtime", {
    LANES: "published-upgrade-survivor",
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS:
      "package-publication-recovery package-verification-recovery package-stranded-first-hop",
  });
  expect(fixture.result.status, fixture.result.stderr).toBe(0);
  expect(JSON.parse(fixture.result.stdout)).toHaveLength(5);
  expect(fixture.report.baselines).toMatchObject(
    ["8", "9", "7"].map((patch) => ({ baseline: `openclaw@2026.9.${patch}`, status: "usable" })),
  );
  expect(io.readJsonLines(fixture.installs)).toHaveLength(3);
});

it.each(["version", "runtime"] as const)("skips unusable %s baselines with evidence", (failure) => {
  const fixture = runFixture(failure);
  expect(fixture.result.status, fixture.result.stderr).toBe(0);
  const groups = JSON.parse(fixture.result.stdout);
  expect(groups).toEqual([
    ...scenarios.map((scenario, index) => ({
      docker_lanes: "published-upgrade-survivor",
      label: `published-upgrade-survivor-2026.8.34-scenarios-${index + 1}`,
      published_upgrade_survivor_baselines: "openclaw@2026.8.34",
      published_upgrade_survivor_scenarios: scenario,
      timeout_minutes: 90,
    })),
    { docker_lanes: "onboard", label: "onboard" },
  ]);
  expect(fixture.report.baselines).toHaveLength(2);
  expect(fixture.report.baselines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ...baseline(33, "skipped"),
        reason: expect.stringContaining("unusable published baseline"),
        error: expect.stringContaining("Cannot find package fixture-runtime"),
      }),
      expect.objectContaining(baseline(34, "usable")),
    ]),
  );
  const installs = io.readJsonLines<Install>(fixture.installs);
  expect(installs).toHaveLength(2);
  for (const install of installs) {
    expect(install.args).toEqual([
      "install",
      "-g",
      "--prefix",
      install.prefix,
      expect.stringMatching(/^openclaw@/),
      "--no-fund",
      "--no-audit",
    ]);
    expect(() => readFileSync(path.join(install.prefix, "bin", "openclaw"))).toThrow();
  }
  const summary = read(path.join(fixture.evidence, "summary.md"));
  expect(summary).toContain("skipped");
  expect(summary).toContain("Cannot find package fixture-runtime");
  expect(summary).not.toContain("passed");
});

it.each([
  { lanes: "published-upgrade-survivor", expected: [] },
  { lanes: "update-migration onboard", expected: ["onboard"] },
])("preserves skip evidence for an inherited baseline in $lanes", ({ lanes, expected }) => {
  const fixture = runFixture("runtime", {
    LANES: lanes,
    GROUP_SIZE: "2",
    OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "",
  });
  expect(fixture.result.status, fixture.result.stderr).toBe(0);
  expect(
    JSON.parse(fixture.result.stdout).map((group: { docker_lanes: string }) => group.docker_lanes),
  ).toEqual(expected);
  expect(fixture.report.baselines).toEqual([
    expect.objectContaining({ baseline: "openclaw@2026.8.33", status: "skipped" }),
  ]);
});

it.each([
  { failure: "install", error: "registry unavailable" },
  { failure: "launch", error: "ENOENT" },
] as const)("fails closed with diagnostics on $failure errors", ({ failure, error }) => {
  const fixture = runFixture(failure);
  expect(fixture.result.status).not.toBe(0);
  expect(
    fixture.report.baselines.find(
      (entry: { baseline: string }) => entry.baseline === "openclaw@2026.8.33",
    ),
  ).toMatchObject({
    baseline: "openclaw@2026.8.33",
    status: "failed",
    error: expect.stringContaining(error),
  });
});
