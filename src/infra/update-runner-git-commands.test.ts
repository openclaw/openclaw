// The Git update clean check honors .gitignore; existing checkouts keep generated
// outputs from retired build pipelines, which must not turn into "dirty" refusals.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeUnsupportedGit } from "./update-runner-git-commands.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const RETIRED_A2UI_OUTPUTS = [
  "extensions/canvas/src/host/a2ui/a2ui.bundle.js",
  "extensions/canvas/src/host/a2ui/a2ui-v0.9.bundle.js",
  "extensions/canvas/src/host/a2ui/a2ui.bundle.js.map",
  "src/canvas-host/a2ui/a2ui.bundle.js",
  "src/canvas-host/a2ui/a2ui.bundle.js.map",
  "vendor/a2ui/renderers/lit/dist/index.js",
];

describe("git update clean check", () => {
  it("keeps retired A2UI build outputs ignored on existing checkouts", () => {
    const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: `${RETIRED_A2UI_OUTPUTS.join("\n")}\n`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual(RETIRED_A2UI_OUTPUTS);
  });
});

describe("git version prerequisite", () => {
  const gitReporting = (stdout: string) => async () => ({ stdout, stderr: "", code: 0 });

  it.each([
    ["git version 2.31.0\n", null],
    ["git version 2.54.0 (Apple Git-157)\n", null],
    ["", null],
    [
      "git version 2.23.0\n",
      /^Update refused: Git 2\.23\.0 at .+ is too old for Git-checkout updates\. Replace it with Git 2\.31 or newer, then retry openclaw update\. No changes were made\.$/u,
    ],
  ])("judges %j", async (stdout, expected) => {
    const verdict = await describeUnsupportedGit(gitReporting(stdout), { timeoutMs: 1000 });
    if (expected === null) {
      expect(verdict).toBeNull();
    } else {
      expect(verdict).toMatch(expected);
    }
  });
});
