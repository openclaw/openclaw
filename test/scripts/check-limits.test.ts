import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportLimitViolations } from "../../scripts/lib/check-limits.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("limit reporting", () => {
  it.each([{}, { CI: "1" }, { GITHUB_ACTIONS: "false" }])(
    "keeps local checks blocking with %j",
    (env) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(
        reportLimitViolations(
          [{ file: "src/example.ts", title: "Line budget", message: "701 > 700" }],
          env,
        ),
      ).toBe(true);
      expect(error).toHaveBeenCalledWith("Line budget\n  src/example.ts: 701 > 700");
      expect(reportLimitViolations([], env)).toBe(false);
    },
  );

  it("escapes workflow commands and writes every warning to the job summary", () => {
    const summary = path.join(tempDirs.make("limit-summary-"), "summary.md");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary };
    expect(
      reportLimitViolations(
        [
          {
            file: "src/a,b%\n.ts",
            title: "Cap: <limit>",
            message: "101 > 100\r\n::error::not a command%",
            line: 2,
          },
        ],
        env,
      ),
    ).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "::warning file=src/a%2Cb%25%0A.ts,line=2,col=0,title=Cap%3A <limit>::101 > 100%0D%0A::error::not a command%25",
    );
    reportLimitViolations([{ file: "second.ts", title: "Count", message: "2 > 1" }], env);
    const contents = fs.readFileSync(summary, "utf8");
    expect(contents).toContain("Cap: &lt;limit&gt;");
    expect(contents).toContain("second.ts");
    expect(contents.split("</p>")).toHaveLength(3);
  });
});
