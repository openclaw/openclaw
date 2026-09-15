// Real-process proof that recovery wrappers keep foreground Gateway drain
// budgets. Kept separate from node-runtime-recovery.test.ts so spawn is not mocked.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";
import { withTempDir } from "../test-utils/temp-dir.js";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

async function waitForReadableFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`, { cause: lastError });
}

describe("runtime recovery Gateway drain (real child)", () => {
  it.runIf(process.platform !== "win32")(
    "lets a real recovery child finish a 3025ms SIGTERM cleanup for foreground Gateway",
    async () => {
      await withTempDir("openclaw-gateway-drain-", async (dir) => {
        const readyPath = path.join(dir, "ready.json");
        const stoppedPath = path.join(dir, "stopped.txt");
        const childScript = path.join(dir, "slow-sigterm-child.mjs");
        await fs.writeFile(
          childScript,
          [
            'import { writeFileSync } from "node:fs";',
            `const readyPath = ${JSON.stringify(readyPath)};`,
            `const stoppedPath = ${JSON.stringify(stoppedPath)};`,
            "writeFileSync(readyPath, JSON.stringify({ pid: process.pid }));",
            'process.on("SIGTERM", () => setTimeout(() => {',
            '  writeFileSync(stoppedPath, "stopped");',
            "  process.exit(0);",
            "}, 3025));",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );

        process.argv = [process.execPath, path.join(dir, "openclaw.mjs"), "gateway", "run"];
        const existingListeners = new Set(process.listeners("SIGTERM"));
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const startedAt = Date.now();

        runRespawnedChild(process.execPath, [childScript], process.env);
        await waitForReadableFile(readyPath, 5000);

        const listener = process
          .listeners("SIGTERM")
          .find((candidate) => !existingListeners.has(candidate));
        expect(listener).toBeDefined();
        listener?.("SIGTERM");

        await waitForReadableFile(stoppedPath, 8000);
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(2800);
        expect(elapsedMs).toBeLessThan(7000);
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
        console.log(
          `recovery child real-request grace: finished cleanup in ${elapsedMs} ms (old launcher cutoff ~2000 ms)`,
        );
      });
    },
  );
});
