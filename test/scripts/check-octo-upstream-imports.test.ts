// Unit test for scripts/check-octo-upstream-imports.mjs (M0-12, OCTO-DEC-040).
//
// Exercises the check against:
//   1. The live src/octo tree (no fixtures) — must be clean. This is the
//      guard that catches real violations landing in production code.
//   2. Fixture files under src/octo/test-fixtures/ and
//      src/octo/adapters/openclaw/test-fixtures/ — the "bad" fixture must be
//      reported as a violation, the "ok" fixture (under the bridge
//      whitelist) must NOT be reported.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCheck } from "../../scripts/check-octo-upstream-imports.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "check-octo-upstream-imports.mjs");

describe("check-octo-upstream-imports — live src/octo tree", () => {
  it("reports no violations on the clean tree", async () => {
    const violations = await runCheck({ includeFixtures: false });
    expect(violations).toEqual([]);
  });
});

describe("check-octo-upstream-imports — fixtures", () => {
  it("flags the bad-import fixture (outside adapters/openclaw/)", async () => {
    const violations = await runCheck({ includeFixtures: true });
    const fromBadFixture = violations.filter((v) =>
      v.file.endsWith("src/octo/test-fixtures/bad-import.ts.fixture"),
    );
    // Should flag both the relative-escape import and the absolute src/ import.
    expect(fromBadFixture.length).toBeGreaterThanOrEqual(2);

    const specifiers = new Set(fromBadFixture.map((v) => v.specifier));
    expect(specifiers.has("../../gateway/server-methods-list")).toBe(true);
    expect(specifiers.has("src/config/loader")).toBe(true);
  });

  it("does NOT flag the ok-import fixture (inside adapters/openclaw/)", async () => {
    const violations = await runCheck({ includeFixtures: true });
    const fromOkFixture = violations.filter((v) =>
      v.file.includes("adapters/openclaw/test-fixtures/ok-import.ts.fixture"),
    );
    expect(fromOkFixture).toEqual([]);
  });
});

describe("check-octo-upstream-imports — CLI entrypoint", () => {
  it("exits 0 on the clean tree (no --include-fixtures)", () => {
    // execFileSync throws on non-zero; reaching the assertion means exit 0.
    const output = execFileSync(process.execPath, [scriptPath, "--quiet"], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    // --quiet suppresses OK output, but if the tree is clean the command
    // succeeds regardless.
    expect(typeof output).toBe("string");
  });

  it("exits 1 when --include-fixtures surfaces the bad fixture", () => {
    let exitCode: number | null = null;
    let stderr = "";
    try {
      execFileSync(process.execPath, [scriptPath, "--include-fixtures"], {
        encoding: "utf8",
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      exitCode = err.status ?? null;
      stderr = err.stderr ?? "";
    }
    expect(exitCode).toBe(1);
    expect(stderr).toContain("OCTO-DEC-033");
    expect(stderr).toContain("bad-import.ts.fixture");
  });
});
