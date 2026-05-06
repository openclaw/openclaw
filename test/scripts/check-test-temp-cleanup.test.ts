import { describe, expect, it } from "vitest";
import { collectTestTempCleanupFindings, main } from "../../scripts/check-test-temp-cleanup.mjs";

describe("check-test-temp-cleanup", () => {
  it("reports current test files that use mkdtemp without obvious cleanup", async () => {
    const findings = await collectTestTempCleanupFindings();

    expect(findings.length).toBeGreaterThan(0);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "test/scripts/blacksmith-testbox-runner.test.ts",
          severity: "error",
        }),
        expect.objectContaining({
          file: "src/gateway/hooks-mapping.test.ts",
          severity: "error",
        }),
        expect.objectContaining({
          file: "extensions/msteams/src/polls.test.ts",
          severity: "error",
        }),
      ]),
    );
  });

  it("keeps files with hooks but no cleanup call in the result set", async () => {
    const findings = await collectTestTempCleanupFindings();
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "src/gateway/hooks-mapping.test.ts",
          severity: "error",
          cleanup: expect.objectContaining({
            hasAfterEach: false,
            hasAfterAll: false,
            hasFinally: false,
            hasCleanupCall: false,
          }),
        }),
      ]),
    );
  });

  it("supports json output for tooling", async () => {
    let stdout = "";
    const exitCode = await main(["--json"], {
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: () => 0 },
    });

    expect(exitCode).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "test/scripts/blacksmith-testbox-runner.test.ts",
        }),
      ]),
    );
  });
});
