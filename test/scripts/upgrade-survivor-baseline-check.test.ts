import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runFixture(
  failure: "version" | "runtime" | "install" | "launch",
  overrides: NodeJS.ProcessEnv = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "survivor-precheck-"));
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
if (${JSON.stringify(failure)} === "install" && spec.endsWith("8.1")) {
  console.error("registry unavailable"); process.exit(1);
}
if (${JSON.stringify(failure)} === "launch" && spec.endsWith("8.1")) process.exit(0);
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
fs.writeFileSync(path.join(prefix, "bin", "openclaw"), '#!/usr/bin/env node\\n' +
  'if (' + JSON.stringify(spec.endsWith("8.1")) + ' && process.argv.includes(' +
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
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "2026.8.1 2026.8.2",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.8.1",
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SCOPE: "all-scenarios",
        OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: "legacy-operator-state base",
        ...overrides,
      },
    },
  );
  return { root, result, evidence, installs };
}

describe("published baseline startup admission", () => {
  it.each(["version", "runtime"] as const)(
    "skips unusable %s baselines with evidence before scheduling scenarios",
    (failure) => {
      const fixture = runFixture(failure);
      try {
        expect(fixture.result.status, fixture.result.stderr).toBe(0);
        const groups = JSON.parse(fixture.result.stdout);
        expect(groups.map((group: { label: string }) => group.label)).toEqual([
          "published-upgrade-survivor-2026.8.2",
          "onboard",
        ]);
        const report = JSON.parse(
          readFileSync(path.join(fixture.evidence, "summary.json"), "utf8"),
        );
        expect(report.baselines).toEqual([
          expect.objectContaining({
            baseline: "openclaw@2026.8.1",
            status: "skipped",
            reason: expect.stringContaining("unusable published baseline"),
            error: expect.stringContaining("Cannot find package fixture-runtime"),
            scenarios: ["legacy-operator-state", "base"],
          }),
          expect.objectContaining({ baseline: "openclaw@2026.8.2", status: "usable" }),
        ]);
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
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
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
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(
        JSON.parse(fixture.result.stdout).map(
          (group: { docker_lanes: string }) => group.docker_lanes,
        ),
      ).toEqual(expected);
      const report = JSON.parse(readFileSync(path.join(fixture.evidence, "summary.json"), "utf8"));
      expect(report.baselines).toEqual([
        expect.objectContaining({ baseline: "openclaw@2026.8.1", status: "skipped" }),
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    { failure: "install", error: "registry unavailable" },
    { failure: "launch", error: "ENOENT" },
  ] as const)(
    "fails closed on $failure errors, preserving diagnostics instead of skipping coverage",
    ({ failure, error }) => {
      const fixture = runFixture(failure);
      try {
        expect(fixture.result.status).not.toBe(0);
        const report = JSON.parse(
          readFileSync(path.join(fixture.evidence, "summary.json"), "utf8"),
        );
        expect(report.baselines[0]).toMatchObject({
          status: "failed",
          error: expect.stringContaining(error),
        });
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
