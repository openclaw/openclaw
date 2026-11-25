import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createProcessSupervisor } from "./supervisor.js";

// Linux host exec always retains a tree owner; other Unix hosts also exercise direct transport.
it.skipIf(process.platform === "win32").each(process.platform === "linux" ? [true] : [false, true])(
  "completes after the root exits while a background child retains stdio (owned tree=%s)",
  async (ownedTree) => {
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    const supervisor = createProcessSupervisor();
    if (ownedTree) {
      supervisor.acquireScopeCleanup("root-exit", { processTree: "required-all" });
    }
    const run = await supervisor.spawn({
      mode: "child",
      argv: ["sh", "-c", "sleep 30 & echo done"],
      scopeKey: "root-exit",
      executionIntent: "agent-tool",
      stdinMode: "pipe-closed",
    });
    const deadline = new AbortController();
    let extinct = false;
    void run.waitForExtinction!().then(() => (extinct = true));
    try {
      const result = await Promise.race([
        run.wait(),
        delay(2_000, "still running", { signal: deadline.signal }),
      ]);
      expect(result).toMatchObject({ exitCode: 0, stdout: "done\n", reason: "exit" });
      // The terminal result cannot certify descendant cleanup.
      expect(extinct).toBe(false);
    } finally {
      deadline.abort();
      await supervisor.shutdown().finally(() => vi.unstubAllEnvs());
    }
  },
);
