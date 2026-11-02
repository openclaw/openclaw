import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { nextEventLoopTurn, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { runWithSpawnBroker } from "./spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "./spawn-broker/host.test-support.js";
import { supportsSpawnBrokerCommandTransport } from "./spawn-broker/pipe.js";
import { spawnNodeTerminalPty } from "./terminal-pty-node.js";
import type { TerminalPtyEvent } from "./terminal-pty-protocol.js";
import {
  spawnTerminalPty,
  type TerminalPtyHandle,
  type TerminalPtySpawnParams,
} from "./terminal-pty.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), TERM: "dumb" };
const handles: TerminalPtyHandle[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const defaults = { file: "/bin/sh", cwd: os.tmpdir(), env, cols: 80, rows: 24 };

async function start(args: string[], params: Partial<TerminalPtySpawnParams> = {}) {
  const handle = await spawnNodeTerminalPty({ ...defaults, args, ...params });
  handles.push(handle);
  return handle;
}

function observe(handle: TerminalPtyHandle, onData?: (output: string) => void) {
  const state = { output: "", exited: false };
  const done = createDeferredCore<{ exitCode: number; signal?: number }>();
  handle.onExit((event) => {
    state.exited = true;
    done.resolve(event);
  });
  handle.onData((data) => {
    expect(state.exited).toBe(false);
    state.output += data;
    onData?.(state.output);
  });
  return { state, done: done.promise };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const handle of handles.splice(0)) {
    handle.kill();
  }
});
const createBroker = useSpawnBrokerTestFixture(afterEach);

describe.runIf(process.platform !== "win32")("Node-owned terminal PTY", () => {
  it.skipIf(!supportsSpawnBrokerCommandTransport()).for(["startup", "running"] as const)(
    "settles terminal %s after losing the real spawn broker",
    async (phase, { signal }) => {
      const broker = (await createBroker())!;
      const brokerPid = broker.pid!;
      const closed = createDeferredCore();
      const spawnBrokerChild = broker.spawn.bind(broker);
      vi.spyOn(broker, "spawn").mockImplementation((...args) => {
        const child = spawnBrokerChild(...args);
        child.once("close", () => closed.resolve());
        return child;
      });
      const killed = createDeferredCore();
      const killBroker = () => {
        process.kill(brokerPid, "SIGKILL");
        killed.resolve();
      };
      let outcome: unknown;
      let ptyPid: number | undefined;
      const starting = runWithSpawnBroker(broker, () =>
        spawnNodeTerminalPty(
          { ...defaults, args: ["-c", "IFS= read -r input"] },
          phase === "startup" ? killBroker : undefined,
        ),
      );
      void starting.then(
        (handle) => {
          handles.push(handle);
          ptyPid = handle.pid;
          handle.onExit((event) => {
            outcome = event;
          });
          if (phase === "running") {
            killBroker();
          }
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await withinTest(killed.promise, signal);
      await withinTest(closed.promise, signal);
      await broker.close();
      await nextEventLoopTurn();
      if (phase === "startup") {
        expect(outcome).toBeInstanceOf(Error);
      } else {
        expect(outcome).toMatchObject({ exitCode: 1 });
      }
      if (ptyPid !== undefined) {
        await waitForDead(ptyPid, signal);
        expect(isPidAlive(ptyPid)).toBe(false);
      }
    },
  );

  it.each(["before", "prepared", "after"] as const)(
    "checks launch policy at the %s PTY boundary",
    async (timing) => {
      const directory = tempDirs.make("openclaw-pty-policy-");
      const marker = path.join(directory, "started");
      const nativeAdmission = createDeferredCore();
      let launchGrants = 0;
      let allowed = true;
      const assertAllowed = () => {
        if (!allowed) {
          throw new Error("PTY policy revoked");
        }
      };
      const broker = supportsSpawnBrokerCommandTransport() ? await createBroker() : undefined;
      const starting = runWithSpawnBroker(broker, () =>
        spawnNodeTerminalPty(
          {
            ...defaults,
            args: ["-c", "touch started; IFS= read -r input; printf 'completed\\n'"],
            cwd: directory,
          },
          assertAllowed,
          (launch, settlement) => {
            launchGrants++;
            if (timing === "prepared") {
              allowed = false;
            }
            assertAllowed();
            if (!settlement) {
              throw new Error("PTY launch did not retain native admission");
            }
            void settlement.then(() => nativeAdmission.resolve(), nativeAdmission.reject);
            return launch();
          },
        ),
      );
      if (timing === "before") {
        // The Node helper has started, but its boot acknowledgement has not arrived.
        allowed = false;
      }
      if (timing !== "after") {
        await expect(starting).rejects.toThrow("PTY policy revoked");
        expect(fs.existsSync(marker)).toBe(false);
        expect(launchGrants).toBe(timing === "prepared" ? 1 : 0);
      } else {
        const handle = await starting;
        handles.push(handle);
        await nativeAdmission.promise;
        expect(launchGrants).toBe(1);
        expect(isPidAlive(handle.pid)).toBe(true);
        allowed = false;
        const { state, done } = observe(handle);
        handle.write("continue\r");
        expect((await done).exitCode).toBe(0);
        expect(state.output).toContain("completed");
        expect(fs.existsSync(marker)).toBe(true);
      }
    },
  );

  it("preserves terminal input, resize ordering, and final output with a non-Node shim first on PATH", async () => {
    const directory = tempDirs.make("openclaw-pty-node-shim-");
    fs.writeFileSync(path.join(directory, "node"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
    const broker = supportsSpawnBrokerCommandTransport() ? await createBroker() : undefined;
    const handle = await runWithSpawnBroker(broker, () =>
      (broker ? spawnTerminalPty : spawnNodeTerminalPty)({
        ...defaults,
        args: [
          "-c",
          'stty -echo; printf "BROKER:%s\\n" "$(ps -o ppid= -p "$PPID")"; printf "READY\\n"; IFS= read -r input; stty size; printf "%s\\n%s\\n" "$input" "$TERM"; exit 7',
        ],
      }),
    );
    handles.push(handle);
    let inputSent = false;
    const { state, done } = observe(handle, (output) => {
      if (!inputSent && output.includes("READY\r\n")) {
        inputSent = true;
        handle.resize(101, 37);
        handle.write("hello 🦞\r");
      }
    });
    expect(await done).toEqual({ exitCode: 7, signal: 0 });
    expect(state.output).toMatch(new RegExp(`^BROKER: *${broker?.pid ?? process.pid}\\r\\n`));
    expect(state.output.slice(state.output.indexOf("READY"))).toBe(
      "READY\r\n37 101\r\nhello 🦞\r\nxterm-256color\r\n",
    );
    expect(isPidAlive(handle.pid)).toBe(false);
  });

  it("retains bounded pipe output while paused and drains it before reporting exit", async () => {
    const directory = tempDirs.make("openclaw-pty-output-");
    const payload = "x".repeat(2 * 1024 * 1024);
    const file = path.join(directory, "output.txt");
    fs.writeFileSync(file, payload);
    const handle = await start([file], { file: "/bin/cat", cwd: directory });
    handle.pause();
    const { state, done } = observe(handle);
    await delay(50);
    expect(state).toEqual({ output: "", exited: false });
    handle.resume();
    await done;
    expect(state.output).toBe(payload);
  });

  it("reaps the PTY and background job on host disconnect", async ({ signal }) => {
    const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.terminalPty);
    const node = resolveTestNodeExecPath();
    const child = spawn(node, resolveRuntimeWorkerArgv(worker, node), {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    const stdout = child.stdout;
    if (!stdout) {
      child.once("error", () => undefined);
      child.kill("SIGKILL");
      throw new Error("Terminal worker did not provide its required output pipe");
    }
    let shellPid: number | undefined;
    let backgroundPid: number | undefined;
    let output = "";
    const started = createDeferredCore();
    const exited = once(child, "exit");
    child.once("error", (error) => started.reject(error));
    child.once("exit", () => started.reject(new Error("Terminal worker exited before output")));
    stdout.setEncoding("utf8");
    stdout.on("data", (data: string) => {
      output += data;
      const match = output.match(/BACKGROUND:(\d+)\r?\n/u);
      if (match) {
        backgroundPid = Number(match[1]);
        started.resolve();
      }
    });
    child.on("message", (raw: unknown) => {
      const message = raw as TerminalPtyEvent;
      if (message.type === "boot") {
        child.send({
          type: "start",
          params: {
            ...defaults,
            file: "/bin/bash",
            args: ["-c", 'set -m; sleep 300 & printf "BACKGROUND:%s\\n" "$!"; wait'],
          },
        });
      } else if (message.type === "ready") {
        shellPid = message.pid;
      } else if (message.type === "error") {
        started.reject(new Error(message.message));
      }
    });
    try {
      await withinTest(started.promise, signal);
      child.disconnect();
      await withinTest(exited, signal);
      expect(shellPid).toBeGreaterThan(0);
      expect(backgroundPid).toBeGreaterThan(0);
      // The worker finishes only after the native shell onExit callback.
      expect(isPidAlive(shellPid!)).toBe(false);
      // Worker exit joins the shell's onExit, but session signaling does not join foreign descendants.
      await waitForDead(backgroundPid!, signal);
      expect(isPidAlive(backgroundPid!)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      killPidIfAlive(backgroundPid);
      killPidIfAlive(shellPid);
    }
  });
});
