import childProcess from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  quoteShell,
  runWorkflowShellScript,
  testNodeExecPath,
} from "./ci-workflow.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

describe("workflow fixture child deadline", () => {
  it("completes here-string input and redirected heredoc output handoff", () => {
    // Stay below Bash's tempfile threshold so the pipe-backed path is exercised.
    const input = "x".repeat(4 * 1024);
    const result = runWorkflowShellScript(
      [
        `value="$(cat <<< '${input}')"`,
        `${quoteShell(testNodeExecPath)} --input-type=module >> "$TMPDIR/outcome" <<'NODE'`,
        'process.stdout.write("fixture-outcome=pass\\n");',
        "NODE",
        'printf "%s\\n" "${#value}"',
        'cat "$TMPDIR/outcome"',
      ].join("\n"),
      { timeout: 1_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${input.length}\nfixture-outcome=pass\n`);
  });

  it("supplies a finite positive deadline when the caller omits one", () => {
    const spawn = vi.spyOn(childProcess, "spawnSync");
    syncBuiltinESMExports();
    try {
      expect(runWorkflowShellScript(":", {}).status).toBe(0);
      const timeout = spawn.mock.calls[0]?.[2]?.timeout;
      expect(Number.isFinite(timeout)).toBe(true);
      expect(timeout).toBeGreaterThan(0);
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("names and terminates a stalled command, including one that ignores SIGTERM", () => {
    for (const script of [
      "echo fixture-ready; while :; do :; done",
      "trap '' TERM\necho fixture-ready\nwhile :; do :; done",
    ]) {
      expect(() => runWorkflowShellScript(script, { timeout: 500 })).toThrow(
        new RegExp(
          `Workflow fixture command timed out after 500 ms: '${process.platform === "darwin" ? "/bin/bash" : "bash"}' .*run\\.sh'\\nfixture-ready`,
        ),
      );
    }
  });
});

describe("workflow fixture file-backed module stdin", () => {
  it.each([
    { operator: ">>", target: '"$GITHUB_ENV"', file: "output with spaces", exit: 0 },
    { operator: ">", target: "'output with spaces'", file: "output with spaces", exit: 7 },
    { operator: ">>", target: "output.jsonl", file: "output.jsonl", exit: 0 },
  ])("preserves redirected module behavior for %j", (row) => {
    const root = temporary.make("workflow-module-stdin-");
    const output = path.join(root, row.file);
    writeFileSync(path.join(root, "value.mjs"), 'export const value = "relative-import";\n');
    writeFileSync(output, "existing-output\n");
    const nativeSpawn = childProcess.spawnSync;
    let stagedScript = "";
    const spawn = vi
      .spyOn(childProcess, "spawnSync")
      .mockImplementation((...args: Parameters<typeof childProcess.spawnSync>) => {
        const script = args[1]?.[0];
        if (typeof script === "string") {
          stagedScript = readFileSync(script, "utf8");
        }
        return nativeSpawn(...args);
      });
    syncBuiltinESMExports();
    try {
      const result = runWorkflowShellScript(
        `set -euo pipefail
node --input-type=module ${row.operator} ${row.target} <<'FIXTURE_MODULE'
import { value } from "./value.mjs";
console.log(JSON.stringify({ value, literal: "$body", argv: process.argv.slice(1) }));
process.exitCode = ${row.exit};
FIXTURE_MODULE
`,
        { cwd: root, env: { ...process.env, GITHUB_ENV: output, body: "must-not-expand" } },
      );
      expect(result.status, result.stderr).toBe(row.exit);
      expect(result.stdout).toBe("");
      expect(stagedScript).not.toContain("<<'FIXTURE_MODULE'");
      expect(stagedScript).toContain(`${row.operator} ${row.target} < `);
      expect(readFileSync(output, "utf8")).toBe(
        `${row.operator === ">>" ? "existing-output\n" : ""}${JSON.stringify({
          value: "relative-import",
          literal: "$body",
          argv: [],
        })}\n`,
      );
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
