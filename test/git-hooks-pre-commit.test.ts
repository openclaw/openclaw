import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("git-hooks/pre-commit", () => {
  it("avoids option injection and unsafe whitespace parsing", () => {
    const scriptPath = path.join(process.cwd(), "git-hooks", "pre-commit");
    const script = readFileSync(scriptPath, "utf8");

    // NUL-delimited list: supports spaces/newlines in filenames.
    expect(script).toMatch(/--name-only/);
    expect(script).toMatch(/--diff-filter=ACMR/);
    expect(script).toMatch(/\s-z\b/);
    expect(script).toMatch(/mapfile -d '' -t files/);

    // Option-injection hardening: always pass paths after "--".
    expect(script).toMatch(/\ngit add -- /);

    // The original bug used whitespace + xargs.
    expect(script).not.toMatch(/xargs\s+git add/);

    // Expected helper wiring for consistent tool invocation.
    expect(script).toMatch(/scripts\/pre-commit\/run-node-tool\.sh/);
    expect(script).toMatch(/scripts\/pre-commit\/filter-staged-files\.mjs/);
  });
});
