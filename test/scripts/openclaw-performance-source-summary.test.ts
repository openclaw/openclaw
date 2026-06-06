import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/openclaw-performance-source-summary.mjs";

describe("parseArgs", () => {
  it("parses source summary paths", () => {
    expect(
      parseArgs([
        "--source-dir",
        "reports/current",
        "--baseline-source-dir",
        "reports/baseline",
        "--output",
        "summary.md",
      ]),
    ).toEqual({
      sourceDir: path.resolve("reports/current"),
      baselineSourceDir: path.resolve("reports/baseline"),
      output: path.resolve("summary.md"),
    });
  });

  it("rejects missing path values", () => {
    for (const flag of ["--source-dir", "--baseline-source-dir", "--output"]) {
      expect(() => parseArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, ""])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "--source-dir", "reports/current"])).toThrow(
        `${flag} requires a value`,
      );
    }
  });
});
