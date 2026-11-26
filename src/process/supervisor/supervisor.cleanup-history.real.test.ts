import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { parseLinuxProcessStat } from "../../shared/pid-alive.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { runWithProcessCleanupBudget } from "./cleanup-budget.js";
import { createProcessSupervisor } from "./supervisor.js";

it.skipIf(process.platform !== "linux")(
  "retains kernel custody of detached descendants after the command anchor dies",
  async () => {
    const supervisor = createProcessSupervisor();
    const closeScope = supervisor.acquireScopeCleanup("lost-anchor", { processTree: "owned-only" });
    let output = "";
    const run = await supervisor.spawn({
      mode: "child",
      scopeKey: "lost-anchor",
      argv: [
        process.execPath,
        "-e",
        `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e',
          'setInterval(() => {}, 1000); process.send("ready");'],
          { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.once('message', () => console.log(process.ppid + ' ' + child.pid));
        setInterval(() => {}, 1000);
      `,
      ],
      stdinMode: "pipe-closed",
      onStdout: (chunk) => (output += chunk),
    });
    let anchor: number | undefined;
    let descendant: number | undefined;
    try {
      await expect.poll(() => /^\d+ \d+\n$/u.test(output)).toBe(true);
      [anchor, descendant] = output.trim().split(/\s+/u).map(Number);
      expect(anchor).toBeGreaterThan(0);
      expect(descendant).toBeGreaterThan(0);
      expect(existsSync(`/proc/${descendant}`)).toBe(true);
      process.kill(anchor!, "SIGKILL");
      // The root result can be lost, but cleanup must independently adopt,
      // stop and reap every descendant before permitting another stream.
      await expect(run.wait()).rejects.toThrow("anchor exited before its command result");
      await expect(run.waitForExtinction!()).resolves.toBeUndefined();
      expect(existsSync(`/proc/${run.pid}`)).toBe(false);
      expect(existsSync(`/proc/${descendant}`)).toBe(false);
      await expect(closeScope()).resolves.toBeUndefined();
    } finally {
      killPidIfAlive(run.pid);
      killPidIfAlive(descendant);
      await closeScope().catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "returns the requested cancellation after forced native cleanup loses the anchor result",
  async () => {
    const supervisor = createProcessSupervisor();
    const closeScope = supervisor.acquireScopeCleanup("forced-cancel", {
      processTree: "required-all",
    });
    let output = "";
    const run = await supervisor.spawn({
      mode: "child",
      scopeKey: "forced-cancel",
      argv: [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");',
      ],
      stdinMode: "pipe-closed",
      onStdout: (chunk) => (output += chunk),
    });
    try {
      await expect.poll(() => output).toBe("ready");
      await runWithProcessCleanupBudget(
        { deadline: performance.now() + 500, warn() {} },
        closeScope,
      );
      await expect(run.wait()).resolves.toMatchObject({
        reason: "manual-cancel",
        exitSignal: "SIGKILL",
      });
      await expect(run.waitForExtinction!()).resolves.toBeUndefined();
      expect(existsSync(`/proc/${run.pid}`)).toBe(false);
    } finally {
      await closeScope().catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  },
);

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
  "does not block shutdown after a deadline failure and native descendant retirement",
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
    const custody = parseLinuxProcessStat(
      anchor!,
      readFileSync(`/proc/${anchor}/stat`, "utf8"),
    )!.parentPid;
    expect(readFileSync(`/proc/${custody}/cmdline`, "utf8")).toContain("service-child-relay");
    try {
      // Stall the independent custodian, not the now-recoverable command anchor,
      // so no kernel extinction certificate can beat the host deadline.
      process.kill(custody, "SIGSTOP");
      const cleanup = runWithProcessCleanupBudget(
        { deadline: performance.now() + 100, warn() {} },
        closeScope,
      );
      await expect(cleanup).rejects.toThrow("hard deadline");
      process.kill(custody, "SIGCONT");
      await expect.poll(() => existsSync(`/proc/${descendant}`)).toBe(false);
      await expect.poll(() => existsSync(`/proc/${anchor}`)).toBe(false);
      await expect(run.waitForExtinction!()).rejects.toThrow("hard deadline");
      // The failed run retains its diagnostic; it is no longer live ownership.
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      if (existsSync(`/proc/${custody}`)) {
        process.kill(custody, "SIGCONT");
      }
      await closeScope().catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  },
);
