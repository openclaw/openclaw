// Docs i18n tests cover the Go module backing docs translation.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("docs-i18n Go module", () => {
  it("passes Go tests", () => {
    const result = spawnSync("go", ["test", "./...", "-count=1"], {
      cwd: "scripts/docs-i18n",
      encoding: "utf8",
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
