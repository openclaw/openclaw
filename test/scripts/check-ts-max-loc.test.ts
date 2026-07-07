// Check Ts Max Loc tests cover CLI argument validation before repository scans.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runCheckTsMaxLoc(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/check-ts-max-loc.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("scripts/check-ts-max-loc", () => {
  it("rejects unknown options before scanning files", () => {
    const result = runCheckTsMaxLoc(["--unknown"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unknown argument: --unknown\n");
  });

  it("rejects non-positive max values before scanning files", () => {
    for (const value of ["-1", "0"]) {
      const result = runCheckTsMaxLoc(["--max", value]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("--max requires a positive integer\n");
    }
  });
});
