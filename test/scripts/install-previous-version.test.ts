import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtureStop = 73;
function runInstallerVersionSelection(
  runner: string,
  options: { target?: string; versions?: string[]; previous?: string; skipPrevious?: boolean },
) {
  const root = tempDirs.make("openclaw-install-previous-");
  const binDir = path.join(root, "bin");
  const callsFile = path.join(root, "calls.jsonl");
  mkdirSync(binDir);
  const executable = (name: string, script: string) =>
    writeFileSync(path.join(binDir, name), script, { mode: 0o755 });
  executable(
    "npm",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
while (args[0]?.startsWith("--")) args.shift();
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "install") process.exit(${fixtureStop});
if (args[0] !== "view") process.exit(74);
process.stdout.write(process.env[args.includes("versions") ? "FIXTURE_VERSIONS" : "FIXTURE_TARGET"]);
`,
  );
  executable(
    "curl",
    `#!/bin/sh\nset -eu\nprintf '%s\\n' '["installer"]' >> "$FIXTURE_CALLS"\nexit ${fixtureStop}\n`,
  );
  executable("timeout", '#!/usr/bin/env bash\nshift 2\nexec "$@"\n');
  const result = spawnSync("bash", [`scripts/docker/install-sh-${runner}/run.sh`], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      NPM_CONFIG_PREFIX: path.join(root, "npm-global"),
      NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"),
      FIXTURE_CALLS: callsFile,
      FIXTURE_TARGET: options.target ?? "2026.7.1",
      FIXTURE_VERSIONS: JSON.stringify(options.versions ?? []),
      OPENAI_API_KEY: "fixture-api-key",
      OPENCLAW_E2E_MODELS: "openai",
      OPENCLAW_INSTALL_TAG: options.target ?? "2026.7.1",
      [`OPENCLAW_INSTALL_${runner.toUpperCase()}_PREVIOUS`]: options.previous ?? "",
      [`OPENCLAW_INSTALL_${runner.toUpperCase()}_SKIP_PREVIOUS`]: options.skipPrevious ? "1" : "0",
      OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL: "0",
    },
  });
  const calls = readFileSync(callsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): string[] => JSON.parse(line));
  return { ...result, calls };
}
describe.each(["e2e", "smoke"])("%s installer upgrade baseline", (runner) => {
  it("preinstalls the target's predecessor despite newer publications", () => {
    const target = "2026.7.1";
    const previous = "2026.7.1-beta.2";
    const result = runInstallerVersionSelection(runner, {
      target,
      versions: [previous, target, "2026.8.1"],
    });
    expect(result.status, result.stderr).toBe(fixtureStop);
    expect(result.calls).toContainEqual(["install", "-g", `openclaw@${previous}`]);
  });
  it("rejects a missing predecessor before installing", () => {
    const result = runInstallerVersionSelection(runner, { versions: ["2026.7.1"] });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No published predecessor");
    expect(result.calls.every(([command]) => command === "view")).toBe(true);
  });
  it.each([
    ["explicit baseline", { previous: "2026.6.1" }, ["install", "-g", "openclaw@2026.6.1"]],
    ["skips preinstallation for a fresh install", { skipPrevious: true }, ["installer"]],
  ] as const)("uses %s without querying the version history", (_name, options, expected) => {
    const result = runInstallerVersionSelection(runner, options);
    expect(result.status, result.stderr).toBe(fixtureStop);
    expect(result.calls).toEqual([
      ["view", runner === "e2e" ? "openclaw@2026.7.1" : "openclaw", "version"],
      expected,
    ]);
  });
});
