import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { runWorkflowShellScript } from "./ci-workflow.test-support.js";

describe("workflow fixture child deadline", () => {
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
        /Workflow fixture command timed out after 500 ms: 'bash' .*run\.sh'\nfixture-ready/,
      );
    }
  });
});
