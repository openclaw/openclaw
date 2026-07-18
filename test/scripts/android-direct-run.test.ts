import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function runTsScriptHelp(scriptPath: string) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("Android script direct-run guards", () => {
  it("runs android-pin-version help through the script entrypoint", () => {
    const result = runTsScriptHelp(path.join("scripts", "android-pin-version.ts"));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/android-pin-version.ts");
  });

  it("runs android-app-i18n help through the script entrypoint", () => {
    const result = runTsScriptHelp(path.join("scripts", "android-app-i18n.ts"));

    expect(`${result.stdout}${result.stderr}`).toContain(
      "usage: node --import tsx scripts/android-app-i18n.ts <sync|check>",
    );
  });
});
