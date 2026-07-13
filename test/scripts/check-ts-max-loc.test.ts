// Check Ts Max Loc tests cover CLI argument validation before repository scans.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLocBaseline,
  countPhysicalLines,
  findLocRatchetViolations,
  isProductionTypeScriptFile,
} from "../../scripts/check-ts-max-loc.js";

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

  it("rejects the removed comparison flag before scanning files", () => {
    const result = runCheckTsMaxLoc(["--base-ref", "refs/remotes/origin/pr-base"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Unknown argument: --base-ref\n");
  });

  it("grandfathers exact legacy sizes and rejects growth or stale baselines", () => {
    const violations = findLocRatchetViolations({
      maxLines: 500,
      baseline: {
        "src/grew.ts": 700,
        "src/shrank.ts": 700,
        "src/now-small.ts": 700,
        "src/removed.ts": 700,
        "src/unchanged.ts": 700,
      },
      results: [
        { filePath: "src/grew.ts", lines: 701 },
        { filePath: "src/new.ts", lines: 501 },
        { filePath: "src/now-small.ts", lines: 500 },
        { filePath: "src/shrank.ts", lines: 699 },
        { filePath: "src/unchanged.ts", lines: 700 },
      ],
    });

    expect(violations).toEqual([
      { filePath: "src/grew.ts", lines: 701, baselineLines: 700, reason: "grew" },
      { filePath: "src/shrank.ts", lines: 699, baselineLines: 700, reason: "baseline-stale" },
      { filePath: "src/new.ts", lines: 501, reason: "baseline-missing" },
      {
        filePath: "src/now-small.ts",
        lines: 500,
        baselineLines: 700,
        reason: "baseline-stale",
      },
      { filePath: "src/removed.ts", lines: 0, baselineLines: 700, reason: "baseline-stale" },
    ]);
  });

  it("counts physical lines without treating a terminal newline as another line", () => {
    expect(countPhysicalLines("")).toBe(0);
    expect(countPhysicalLines("one")).toBe(1);
    expect(countPhysicalLines("one\n")).toBe(1);
    expect(countPhysicalLines("one\ntwo\n")).toBe(2);
  });

  it("excludes repository test and test-support naming conventions", () => {
    expect(isProductionTypeScriptFile("src/runtime.ts")).toBe(true);
    expect(isProductionTypeScriptFile("src/runtime.mts")).toBe(true);
    expect(isProductionTypeScriptFile("src/runtime.cts")).toBe(true);
    for (const filePath of [
      "src/runtime.test.ts",
      "src/runtime.spec.tsx",
      "src/runtime.suite.ts",
      "src/runtime.test-harness.ts",
      "src/runtime.test-support.ts",
      "src/runtime-test-helpers.ts",
      "src/test-helpers/runtime.ts",
      "test/runtime.ts",
    ]) {
      expect(isProductionTypeScriptFile(filePath), filePath).toBe(false);
    }
  });

  it("excludes Control UI locale bundles", () => {
    expect(isProductionTypeScriptFile("ui/src/i18n/locales/en.ts")).toBe(false);
    expect(isProductionTypeScriptFile("ui/src/i18n/locales/fr.ts")).toBe(false);
    expect(isProductionTypeScriptFile("ui/src/i18n/lib/translate.ts")).toBe(true);
  });

  it("builds a reviewable baseline from current oversized files, including growth", () => {
    expect(
      buildLocBaseline(
        [
          { filePath: "src/grew.ts", lines: 701 },
          { filePath: "src/new.ts", lines: 501 },
          { filePath: "src/small.ts", lines: 500 },
        ],
        500,
      ),
    ).toEqual({
      "src/grew.ts": 701,
      "src/new.ts": 501,
    });
  });
});
