import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  quoteShell,
  runWorkflowShellScript,
  testNodeExecPath,
} from "./ci-workflow.test-support.js";

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
