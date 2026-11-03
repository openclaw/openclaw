import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createProcessSupervisor } from "./supervisor.js";

it.skipIf(process.platform === "win32").each([false, true])(
  "completes after the root exits while a background child retains stdio (service relay=%s)",
  async (serviceRelay) => {
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    const supervisor = createProcessSupervisor();
    const run = await supervisor.spawn({
      mode: "child",
      argv: ["sh", "-c", "sleep 30 & echo done"],
      executionIntent: "agent-tool",
      stdinMode: "pipe-closed",
      ...(serviceRelay ? { memoryLimitBytes: 1024 ** 3 } : {}),
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
