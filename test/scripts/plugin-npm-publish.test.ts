// Plugin NPM Publish tests cover publish wrapper argument safety.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/plugin-npm-publish.sh";

function runPluginPublishWrapper(args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("plugin npm publish wrapper", () => {
  it("prints help before package or npm checks", () => {
    const result = runPluginPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack-dry-run|--publish] <package-dir>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing mode before package checks", () => {
    const result = runPluginPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/plugin-npm-publish.sh [--dry-run|--pack-dry-run|--publish] <package-dir>",
    );
  });

  it("rejects option-like package dirs before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "--wat"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm package-dir option: --wat");
  });

  it("rejects extra arguments before package checks", () => {
    const result = runPluginPublishWrapper(["--dry-run", "extensions/telegram", "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unexpected plugin npm publish argument: extra");
  });
});
