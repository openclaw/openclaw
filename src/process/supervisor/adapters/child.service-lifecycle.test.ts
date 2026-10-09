import { spawn } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as realDelay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { waitForPidFile } from "../../../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { killPidIfAlive } from "../../../test-utils/process-tree.js";
import { mockProcessPlatform } from "../../../test-utils/vitest-spies.js";
import * as relayIntegration from "../../spawn-broker/relay-integration.js";
import { createProcessSupervisor } from "../supervisor.js";
import { createChildAdapter } from "./child.js";
import {
  describeSpawnTransports,
  isAlive,
  serviceChildHostTransportPrelude,
  waitFor,
} from "./child.service-lifecycle.test-support.js";
import { readyChildAdapter } from "./child.test-support.js";

const startChildAdapter = readyChildAdapter(createChildAdapter);
const managedTransports = process.versions.bun ? ["native"] : ["broker"];
function startNode(
  script: string,
  options: Omit<Parameters<typeof startChildAdapter>[0], "argv" | "anchoredShellCommand"> = {},
) {
  return startChildAdapter({
    argv: [process.execPath, "-e", script],
    stdinMode: "pipe-closed",
    ...options,
  });
}

const activePids = new Set<number>();
const DESCENDANT_CLEANUP_GUARD_MS = 5_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function parsePidPair(output: string): [number, number] {
  const match = /(\d+)\s+(\d+)/u.exec(output);
  if (!match?.[1] || !match[2]) {
    throw new Error(`expected PID pair in output: ${JSON.stringify(output)}`);
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

function createRetainedDescendantFixture() {
  const cwd = tempDirs.make("openclaw-service-retained-descendant-");
  const pidPath = path.join(cwd, "descendant.pid");
  const releasePath = path.join(cwd, "descendant.release");
  const descendantScript = `
    const { existsSync, writeFileSync } = require("node:fs");
    const releaseTimer = setInterval(() => {
      if (existsSync(${JSON.stringify(releasePath)})) {
        clearInterval(releaseTimer);
      }
    }, 20);
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
  `;
  const readPid = async (signal: AbortSignal) => {
    const pid = await waitForPidFile(pidPath, signal);
    activePids.add(pid);
    return pid;
  };
  return {
    // Only lineage is inherited, so root output EOF is independent of descendant lifetime.
    rootScript: `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
        stdio: ["ignore", "ignore", "ignore", 3],
      });
      descendant.unref();
    `,
    readPid,
    releaseAndJoin: async <T>(waitForExtinction: () => Promise<T>, signal: AbortSignal) => {
      await writeFile(releasePath, "", "utf8");
      // Read again on failure paths where readiness was not observed before cleanup.
      // Cleanup hang guard after the owner released the descendant, not a readiness race.
      const pid = await readPid(AbortSignal.timeout(DESCENDANT_CLEANUP_GUARD_MS));
      await Promise.all([withinTest(waitForExtinction(), signal), waitFor(() => !isAlive(pid))]);
      activePids.delete(pid);
    },
  };
}

async function expectPending<T>(promise: Promise<T>) {
  expect(await Promise.race([promise.then(() => true), nextTurn().then(() => false)])).toBe(false);
}

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.OPENCLAW_SERVICE_MARKER;
  for (const pid of activePids) {
    killPidIfAlive(pid);
  }
  await waitFor(() => [...activePids].every((pid) => !isAlive(pid))).catch(() => {});
  activePids.clear();
});

describeSpawnTransports("POSIX child invocation identity", (transport) => {
  it.each(transport === "native" ? ["direct"] : ["direct", "service-managed"])(
    "preserves caller-selected argv0 through the %s path",
    async (mode) => {
      if (mode === "service-managed") {
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      }
      const tempDir = tempDirs.make(`openclaw-${mode}-argv0-`);
      const executableAlias = path.join(tempDir, "claude-shim");
      await symlink(process.execPath, executableAlias);
      const run = await createProcessSupervisor().spawn({
        mode: "child",
        argv: [process.execPath, "-e", "process.stdout.write(process.argv0)"],
        argv0: executableAlias,
        exactEnv: mode === "service-managed" ? true : undefined,
      });

      await expect(run.wait()).resolves.toMatchObject({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        stdout: executableAlias,
      });
      await run.waitForExtinction?.();
    },
  );
});

describeSpawnTransports(
  "service-managed child lifecycle",
  () => {
    it("rejects NUL input before creating a relay and leaves shutdown clean", async () => {
      process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      const supervisor = createProcessSupervisor();
      const relay = vi.spyOn(relayIntegration, "spawnServiceChildRelay");
      try {
        await expect(
          supervisor.spawn({ mode: "child", argv: ["/bin/sh", "-c", "printf bad\0command"] }),
        ).rejects.toThrow(/NUL bytes|null bytes/);
        await expect(
          supervisor.spawn({ mode: "anchored-shell", command: "printf bad\0command" }),
        ).rejects.toThrow(/NUL bytes|null bytes/);
        expect(relay.mock.calls.length).toBe(0);
        const run = await supervisor.spawn({ mode: "anchored-shell", command: "printf ready" });
        await expect(run.wait()).resolves.toMatchObject({ exitCode: 0, stdout: "ready" });
        await run.waitForExtinction?.();
      } finally {
        relay.mockRestore();
        await supervisor.shutdown();
      }
    });

    it.each([
      { reason: "manual-cancel" as const, timeoutMs: undefined, noOutputTimeoutMs: undefined },
      { reason: "no-output-timeout" as const, timeoutMs: undefined, noOutputTimeoutMs: 100 },
    ])("removes the group before returning $reason", async (timing) => {
      process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      // Deadlines include construction. Hold the clock until the real PID banner
      // so this case tests admitted-group cleanup independently of startup speed.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const supervisor = createProcessSupervisor();
      let output = "";
      try {
        const run = await supervisor.spawn({
          mode: "child",
          argv: [
            "/bin/sh",
            "-c",
            'sleep 60 >/dev/null 2>&1 & child=$!; printf "%s %s\\n" "$$" "$child"; wait',
          ],
          stdinMode: "pipe-closed",
          timeoutMs: timing.timeoutMs,
          noOutputTimeoutMs: timing.noOutputTimeoutMs,
          onStdout: (chunk) => {
            output += chunk;
          },
        });
        await waitFor(() => /^\d+ \d+/u.test(output));
        const [rootPid, descendantPid] = parsePidPair(output);
        activePids.add(rootPid);
        activePids.add(descendantPid);
        expect(isAlive(rootPid) && isAlive(descendantPid)).toBe(true);
        if (timing.reason === "manual-cancel") {
          run.cancel();
        } else {
          await vi.advanceTimersByTimeAsync(100);
          // Deadline decisions wait one timer turn for pending child exit notifications.
          await vi.advanceTimersToNextTimerAsync();
        }
        const exit = await run.wait();
        expect(exit.reason).toBe(timing.reason);
        expect(parsePidPair(exit.stdout)).toEqual([rootPid, descendantPid]);
        await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
      } finally {
        vi.useRealTimers();
        await supervisor.shutdown();
      }
    });

    it("drains backpressured output before closing after cancellation at root exit", async () => {
      const outputBytes = 256 * 1024;
      const adapter = await startNode(
        `process.stdout.write(Buffer.alloc(${outputBytes}, 120), () => process.exit(23));`,
        { ownProcessTree: true },
      );
      activePids.add(adapter.pid!);
      let receivedBytes = 0;
      let subscribed = false;
      const subscribe = () => {
        if (subscribed) {
          return;
        }
        subscribed = true;
        adapter.onStdout((chunk) => {
          receivedBytes += Buffer.byteLength(chunk);
        });
      };
      const rootExit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      adapter.onExit((code, signal) => {
        adapter.kill("SIGTERM");
        rootExit.resolve({ code, signal });
      });
      // Small native pipe buffers can block the root's final write. Release that
      // pressure within the TERM budget; larger buffers exercise exit before drain.
      const releaseBlockedRoot = setTimeout(subscribe, 1_000);
      try {
        await expect(rootExit.promise).resolves.toEqual({ code: 23, signal: null });
        clearTimeout(releaseBlockedRoot);
        // Give cleanup the opportunity to close while forwarding is backpressured.
        await Promise.race([adapter.waitForExtinction!(), realDelay(200)]);
        subscribe();
        await expect(adapter.wait()).resolves.toEqual({ code: 23, signal: null });
        await adapter.waitForExtinction!();
        expect(receivedBytes).toBe(outputBytes);
      } finally {
        clearTimeout(releaseBlockedRoot);
        subscribe();
        adapter.kill("SIGKILL");
        await adapter.waitForExtinction!();
        adapter.dispose();
      }
    });

    it.each(
      process.platform === "linux" && !process.versions.bun
        ? ["process-group", "linux-subreaper"]
        : ["process-group"],
    )(
      "uses %s custody after KILL when an escaped descendant retains lineage",
      async (ownership) => {
        const descendantScript = `process.send("ready"); setInterval(() => {}, 1000);`;
        const rootScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", 3, "ipc"],
      });
      child.once("message", () => {
        process.stdout.write(process.pid + " " + child.pid + "\\n", () => {
          child.disconnect();
          process.exit(0);
        });
      });
    `;
        const relayExited = createDeferred();
        const spawnRelay = relayIntegration.spawnServiceChildRelay;
        const observeRelay = vi
          .spyOn(relayIntegration, "spawnServiceChildRelay")
          .mockImplementation((params) => {
            const relay = spawnRelay(params);
            relay.child.once("exit", () => relayExited.resolve());
            return relay;
          });
        // Select the retained POSIX group contract only for its escape-limit case.
        const groupPlatform =
          ownership === "process-group" ? mockProcessPlatform("darwin") : undefined;
        let adapter: Awaited<ReturnType<typeof startChildAdapter>>;
        try {
          adapter = await startNode(rootScript, { ownProcessTree: true });
        } finally {
          observeRelay.mockRestore();
          groupPlatform?.mockRestore();
        }
        const output: string[] = [];
        adapter.onStdout((chunk) => output.push(chunk));
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        const [rootPid, descendantPid] = parsePidPair(output.join(""));
        activePids.add(rootPid);
        activePids.add(descendantPid);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const extinction = adapter.waitForExtinction!();
          const settled = vi.fn();
          void extinction.then(settled, settled);
          adapter.kill("SIGKILL");
          // Real relay exit follows the closing acknowledgement; its host deadline is now armed.
          await relayExited.promise;
          if (ownership === "linux-subreaper") {
            // Kernel adoption, unlike PGID membership, retains an escaped child.
            await expect(extinction).resolves.toBeUndefined();
            expect(isAlive(descendantPid)).toBe(false);
            await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
            return;
          }
          expect(isAlive(descendantPid)).toBe(true);
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(4_999);
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          await expect(extinction).rejects.toThrow(
            "service child cleanup did not complete before its hard deadline",
          );
          await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
          expect(isAlive(descendantPid)).toBe(true);
        } finally {
          vi.useRealTimers();
          killPidIfAlive(descendantPid);
          try {
            await waitFor(() => !isAlive(descendantPid));
          } finally {
            adapter.dispose();
          }
        }
      },
    );

    it("flushes incomplete UTF-8 before exposing a root result with retained authority", async ({
      signal,
    }) => {
      process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      const fixture = createRetainedDescendantFixture();
      const rootScript = `
      ${fixture.rootScript}
      process.stdout.write(Buffer.from([0x58, 0xe2, 0x82]), () => process.exit(0));
    `;
      let streamed = "";
      const raw: Buffer[] = [];
      const supervisor = createProcessSupervisor();
      const run = await supervisor.spawn({
        mode: "child",
        argv: [process.execPath, "-e", rootScript],
        stdinMode: "pipe-closed",
        onStdout: (chunk) => {
          streamed += chunk;
        },
        onStdoutRaw: (chunk) => {
          raw.push(chunk);
        },
      });
      try {
        const descendantPid = await fixture.readPid(signal);
        const exit = await withinTest(run.wait(), signal);

        expect(exit).toMatchObject({ reason: "exit", exitCode: 0, exitSignal: null });
        expect(exit.stdout).toBe("X�");
        expect(streamed).toBe("X�");
        expect(Buffer.concat(raw)).toEqual(Buffer.from([0x58, 0xe2, 0x82]));
        expect(isAlive(descendantPid)).toBe(true);
        await expectPending(run.waitForExtinction!());
      } finally {
        try {
          await fixture.releaseAndJoin(run.waitForExtinction!, signal);
        } finally {
          await supervisor.shutdown();
        }
      }
    });

    it("reports startup failure before secret-pipe failure without an unhandled rejection", async () => {
      process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      const onUnhandled = vi.fn();
      process.on("unhandledRejection", onUnhandled);
      try {
        await expect(
          startChildAdapter({
            argv: ["/definitely/not/a/real-command"],
            exactEnv: true,
            stdinMode: "pipe-closed",
            secretInput: {
              fd: 3,
              createData: () => Buffer.alloc(8 * 1024 * 1024, 120),
            },
          }),
        ).rejects.toThrow("ENOENT");
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        expect(onUnhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it.each(["service", "owned-worker"] as const)(
      "keeps reopenable secret input distinct from stdin and lifecycle channels (%s)",
      async (mode) => {
        if (mode === "service") {
          process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
        }
        const adapter = await startNode(
          `const fs = require("node:fs");
         const secret = fs.readFileSync(${JSON.stringify(process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3")}, "utf8").trimEnd();
         const input = fs.readFileSync(0, "utf8");
         process.stdout.write(secret.length + ":" + input);`,
          {
            ownedWorker: mode === "owned-worker" ? true : undefined,
            stdinMode: "pipe-open",
            secretInput: {
              fd: 3,
              createData: () => Buffer.from("synthetic-secret\n", "utf8"),
            },
          },
        );
        const output: string[] = [];
        adapter.onStdout((chunk) => output.push(chunk));
        adapter.closeStartGate?.();
        adapter.stdin?.write("ordinary-input\n");
        adapter.stdin?.end();

        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        expect(output.join("")).toBe("16:ordinary-input\n");
      },
    );
  },
  managedTransports,
);

describeSpawnTransports("construction cleanup", () => {
  it("preserves construction cleanup uncertainty while the real command self-cleans", async ({
    signal,
  }) => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const cwd = tempDirs.make("openclaw-service-secret-construction-");
    const pidPath = path.join(cwd, "command.pid");
    const termPath = path.join(cwd, "command.term.pid");
    const command = `
      process.on("SIGTERM", () => {
        require("node:fs").writeFileSync(${JSON.stringify(termPath)}, String(process.pid));
        process.exit(0);
      });
      require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const supervisor = createProcessSupervisor();
    const runId = "service-secret-construction";
    const cleanupScope = supervisor.acquireScopeCleanup(runId, { processTree: "required-all" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pendingRun = supervisor.spawn({
      runId,
      scopeKey: runId,
      mode: "child",
      argv: [process.execPath, "-e", command],
      stdinMode: "pipe-closed",
      timeoutMs: 500,
      secretInput: {
        fd: 3,
        createData: () => Buffer.alloc(8 * 1024 * 1024, 97),
      },
    });
    let commandPid: number | undefined;
    try {
      const startedPid = await waitForPidFile(pidPath, signal, realDelay);
      commandPid = startedPid;
      activePids.add(startedPid);
      expect(isAlive(startedPid)).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      // Let the deferred construction deadline decide before awaiting startup settlement.
      await vi.advanceTimersToNextTimerAsync();
      const run = await pendingRun;
      await expect(run.wait()).resolves.toMatchObject({
        reason: "overall-timeout",
        timedOut: true,
      });
      await expect(cleanupScope()).rejects.toThrow("cleanup identity lost");
      await expect(run.waitForExtinction?.()).rejects.toThrow("cleanup identity lost");
      await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
      // TERM must still reach the command after failed cleanup joins. Dedicated
      // escalation cases cover commands that keep running through the TERM grace.
      await waitForPidFile(termPath, signal, realDelay);
      await waitFor(() => !isAlive(startedPid));
    } finally {
      vi.useRealTimers();
      supervisor.cancel(runId);
      killPidIfAlive(commandPid);
      await pendingRun.catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  });
});

describeSpawnTransports(
  "service host loss",
  () => {
    it("fails closed when the service host exits", async () => {
      const tempDir = tempDirs.make("openclaw-service-child-host-");
      const scriptPath = path.join(tempDir, "host.mts");
      const childModuleUrl = new URL("./child.ts", import.meta.url).href;
      await writeFile(
        scriptPath,
        `
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
        ${serviceChildHostTransportPrelude()}
        const { createChildAdapter } = await import(${JSON.stringify(childModuleUrl)});
        const { adapter, ready } = await withTransport(() => createChildAdapter({
          argv: ["/bin/sh", "-c", 'sleep 60 >/dev/null 2>&1 & child=$!; printf "%s %s\\\\n" "$$" "$child"; wait'],
          stdinMode: "pipe-closed",
        }));
        await ready;
        let output = "";
        adapter.onStdout((chunk) => { output += chunk; });
        while (!/^\\d+ \\d+/u.test(output)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        process.stdout.write("PROBE " + output.trim() + "\\n", () => process.exit(0));
      `,
        "utf8",
      );
      const host = spawn(process.execPath, ["--import", "tsx", scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENCLAW_SERVICE_MARKER: "openclaw" },
      });
      let stdout = "";
      let stderr = "";
      host.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      host.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const exitCode = await new Promise<number | null>((resolve) => {
        host.once("exit", resolve);
      });
      expect(exitCode, stderr).toBe(0);
      const [rootPid, descendantPid] = parsePidPair(stdout);
      activePids.add(rootPid);
      activePids.add(descendantPid);

      await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
    });
  },
  managedTransports,
);
