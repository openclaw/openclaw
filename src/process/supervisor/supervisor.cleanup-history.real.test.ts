import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { isPidAlive } from "../../shared/pid-alive.js";
import { runWithProcessCleanupBudget } from "./cleanup-budget.js";
import { createProcessSupervisor } from "./supervisor.js";

it.skipIf(process.platform !== "linux").each(["", "setsid ", "nohup "])(
  "reaps a background %sgrandchild holding stdout and stderr",
  async (prefix) => {
    const supervisor = createProcessSupervisor();
    const closeScope = supervisor.acquireScopeCleanup("background", {
      processTree: "required-all",
    });
    let output = "";
    const run = await supervisor.spawn({
      mode: "child",
      scopeKey: "background",
      argv: ["sh", "-c", `${prefix}sh -c 'echo $$; exec sleep 600' & wait`],
      stdinMode: "pipe-closed",
      onStdout: (chunk) => (output += chunk),
    });
    try {
      await expect.poll(() => /^\d+\n$/u.test(output)).toBe(true);
      const descendant = Number(output.trim());
      expect(existsSync(`/proc/${descendant}`)).toBe(true);
      await closeScope();
      await run.wait();
      await run.waitForExtinction!();
      expect(existsSync(`/proc/${descendant}`)).toBe(false);
      await supervisor.shutdown();
    } finally {
      await closeScope().catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "kills a stopped native owner before the shutdown deadline and does not block shutdown",
  async () => {
    const supervisor = createProcessSupervisor();
    const closeScope = supervisor.acquireScopeCleanup("deadline", { processTree: "required-all" });
    const run = await supervisor.spawn({
      mode: "child",
      scopeKey: "deadline",
      argv: ["sh", "-c", 'sleep 600 >/dev/null 2>&1 & echo "$PPID $!"'],
      stdinMode: "pipe-closed",
    });
    const result = await run.wait();
    const [anchor, descendant] = result.stdout.trim().split(/\s+/u).map(Number);
    expect(result.exitCode).toBe(0);
    expect(anchor).toBeGreaterThan(0);
    expect(descendant).toBeGreaterThan(0);
    try {
      // Output is complete, but this background child still holds lineage. Stop
      // our native owner so it can read neither cancellation nor its escalation.
      process.kill(anchor!, "SIGSTOP");
      const deadline = performance.now() + 4_000;
      const cleanup = runWithProcessCleanupBudget({ deadline, warn() {} }, closeScope);
      await expect(cleanup).rejects.toThrow("did not answer forced cancellation");
      expect(performance.now()).toBeLessThan(deadline);
      // No SIGCONT: the host itself must retire the owner's group. Its orphaned
      // descendant is reaped by whatever init the host has, so a zombie counts as gone.
      await expect.poll(() => isPidAlive(descendant!)).toBe(false);
      await expect.poll(() => existsSync(`/proc/${anchor}`)).toBe(false);
      await expect(run.waitForExtinction!()).rejects.toThrow("did not answer");
      // The failed run retains its diagnostic; it is no longer live ownership.
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      if (existsSync(`/proc/${anchor}`)) {
        process.kill(anchor!, "SIGCONT");
      }
      await closeScope().catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  },
);
