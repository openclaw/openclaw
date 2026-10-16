import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runFixture(
  failure: "version" | "runtime" | "install" | "launch",
  overrides: NodeJS.ProcessEnv = {},
) {
  const root = tempDirs.make("survivor-precheck-");
  const bin = path.join(root, "bin");
  const evidence = path.join(root, "evidence");
  const installs = path.join(root, "installs.jsonl");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "npm"),
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
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/plan-targeted-docker-lane-groups.mjs", "--check-baselines", evidence],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        LANES: "published-upgrade-survivor onboard",
        GROUP_SIZE: "1",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "2026.8.33 2026.8.34",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.8.33",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SCOPE: "all-scenarios",
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "legacy-operator-state base",
        ...overrides,
      },
    },
  );
  return {
    result,
    evidence,
    installs,
    report: JSON.parse(readFileSync(path.join(evidence, "summary.json"), "utf8")),
  };
}

describe("published baseline startup admission", () => {
  it("checks each pinned recovery driver once before scheduling exact rows", () => {
    const fixture = runFixture("runtime", {
      LANES: "published-upgrade-survivor",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS:
        "package-publication-recovery package-verification-recovery package-stranded-first-hop",
    });
    expect(fixture.result.status, fixture.result.stderr).toBe(0);
    expect(JSON.parse(fixture.result.stdout)).toHaveLength(5);
    expect(
      fixture.report.baselines.map((entry: { baseline: string; status: string }) => [
        entry.baseline,
        entry.status,
      ]),
    ).toEqual([
      ["openclaw@2026.9.8", "usable"],
      ["openclaw@2026.9.9", "usable"],
      ["openclaw@2026.9.7", "usable"],
    ]);
    expect(readFileSync(fixture.installs, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it.each(["version", "runtime"] as const)(
    "skips unusable %s baselines with evidence before scheduling scenarios",
    (failure) => {
      const fixture = runFixture(failure);
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      const groups = JSON.parse(fixture.result.stdout);
      expect(groups).toEqual([
        {
          docker_lanes: "published-upgrade-survivor",
          label: "published-upgrade-survivor-2026.8.34-scenarios-1",
          published_upgrade_survivor_baselines: "openclaw@2026.8.34",
          published_upgrade_survivor_scenarios: "legacy-operator-state",
          timeout_minutes: 90,
        },
        {
          docker_lanes: "published-upgrade-survivor",
          label: "published-upgrade-survivor-2026.8.34-scenarios-2",
          published_upgrade_survivor_baselines: "openclaw@2026.8.34",
          published_upgrade_survivor_scenarios: "base",
          timeout_minutes: 90,
        },
        { docker_lanes: "onboard", label: "onboard" },
      ]);
      expect(fixture.report.baselines).toHaveLength(2);
      expect(fixture.report.baselines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            baseline: "openclaw@2026.8.33",
            status: "skipped",
            reason: expect.stringContaining("unusable published baseline"),
            error: expect.stringContaining("Cannot find package fixture-runtime"),
            scenarios: ["legacy-operator-state", "base"],
          }),
          expect.objectContaining({
            baseline: "openclaw@2026.8.34",
            status: "usable",
            scenarios: ["legacy-operator-state", "base"],
          }),
        ]),
      );
      const installs = readFileSync(fixture.installs, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
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
      const summary = readFileSync(path.join(fixture.evidence, "summary.md"), "utf8");
      expect(summary).toContain("skipped");
      expect(summary).toContain("Cannot find package fixture-runtime");
      expect(summary).not.toContain("passed");
    },
  );

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
      JSON.parse(fixture.result.stdout).map(
        (group: { docker_lanes: string }) => group.docker_lanes,
      ),
    ).toEqual(expected);
    expect(fixture.report.baselines).toEqual([
      expect.objectContaining({ baseline: "openclaw@2026.8.33", status: "skipped" }),
    ]);
  });

  it.each([
    { failure: "install", error: "registry unavailable" },
    { failure: "launch", error: "ENOENT" },
  ] as const)(
    "fails closed on $failure errors, preserving diagnostics instead of skipping coverage",
    ({ failure, error }) => {
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
    },
  );
});
