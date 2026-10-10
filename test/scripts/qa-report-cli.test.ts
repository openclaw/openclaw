// Qa report cli tests cover source entrypoint operator errors.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function runSourceScript(scriptPath: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("QA report source CLIs", () => {
  it("reports unknown QA coverage options without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-coverage-report.ts", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown qa coverage option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("reports unknown QA parity options without a Node stack trace", () => {
    const result = runSourceScript("scripts/qa-parity-report.ts", "--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown qa parity-report option: --wat");
    expectNoNodeStack(result.stderr);
  });
});
