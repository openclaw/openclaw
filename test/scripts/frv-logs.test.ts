import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runLogs(args: string[], logError = "", jobStatus?: string) {
  const root = mkdtempSync(join(tmpdir(), "frv-logs-"));
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const args = process.argv.slice(2);
const jobPath = "repos/openclaw/openclaw/actions/jobs/123";
const expected = jobPath + "/logs";
if (args[0] === "api" && args.includes(jobPath) && ${JSON.stringify(jobStatus ?? null)}) {
  process.stdout.write(JSON.stringify({id: 123, name: "tests", status: ${JSON.stringify(jobStatus ?? null)}}));
  process.exit(0);
}
if (args[0] !== "api" || !args.includes(expected) || !args.includes("--allow-escape-sequences")) {
  console.error("unexpected gh call: " + JSON.stringify(args));
  process.exit(17);
}
if (${JSON.stringify(logError)}) {
  console.error(${JSON.stringify(logError)});
  process.exit(1);
}
process.stdout.write("\\u001b[31mFAIL first\\u001b[0m\\npass second\\nFAIL third\\n");
`,
  );
  chmodSync(gh, 0o755);
  try {
    return spawnSync(
      process.execPath,
      [resolve("scripts/frv.mjs"), "logs", "--job", "123", ...args],
      {
        encoding: "utf8",
        env: { HOME: root, PATH: root },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("frv logs", () => {
  it("downloads a job log through the protected route and strips terminal escapes", () => {
    const result = runLogs([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("FAIL first\npass second\nFAIL third\n");
    expect(result.stdout).not.toContain("\u001b");
  });

  it("filters stripped log lines with a literal grep", () => {
    const result = runLogs(["--grep", "FAIL"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("FAIL first\nFAIL third\n");
  });

  const retryAdvice =
    'Job 123 "tests" is in_progress. Retry the log request after the job completes.';
  it.each([
    ["gh: HTTP 404", "in_progress", retryAdvice],
    ["error: github returned status 404", "in_progress", retryAdvice],
    ["gh: HTTP 404", "completed", "gh: HTTP 404"],
    ["gh: HTTP 403", undefined, "gh: HTTP 403"],
  ] as const)("reports unavailable logs for %s (%s)", (error, status, expected) => {
    const result = runLogs(["--grep", "FAIL"], error, status);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain("unexpected gh call");
  });

  it("requires a positive job id and rejects a parent run selector", () => {
    const missing = spawnSync(
      process.execPath,
      [resolve("scripts/frv.mjs"), "logs", "--job", "0"],
      {
        encoding: "utf8",
      },
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("--job must be a positive integer");

    const parent = spawnSync(
      process.execPath,
      [resolve("scripts/frv.mjs"), "logs", "--job", "123", "--run", "77"],
      { encoding: "utf8" },
    );
    expect(parent.status).toBe(1);
    expect(parent.stderr).toContain("logs does not take --run");
  });
});
