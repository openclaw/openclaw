// Docs i18n behavior tests keep JSON fixture edits tied to the Go baseline suite.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("docs-i18n behavior baselines", () => {
  it("keeps behavior fixtures passing", () => {
    const result = spawnSync(
      "go",
      ["test", "./...", "-run", "TestDocsI18nBehaviorBaselines", "-count=1"],
      {
        cwd: "scripts/docs-i18n",
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
