import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import * as bunAdapter from "./terminal-pty-bun.js";
import * as nodeAdapter from "./terminal-pty-node.js";
import {
  spawnTerminalPty,
  type TerminalPtyHandle,
  type TerminalPtySpawnParams,
} from "./terminal-pty.js";

const handles: TerminalPtyHandle[] = [];
const descendants: number[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const deadline = { timeout: 2_000, interval: 10 };
const ptyDefaults = { file: "/bin/sh", args: [], cols: 80, rows: 24 };
type TerminalCallbacks = {
  data(terminal: unknown, data: Uint8Array): void;
  exit(terminal: unknown): void;
};

const bun = (
  globalThis as typeof globalThis & {
    Bun?: {
      Terminal?: { prototype: { pause?: () => void } };
      spawn(argv: string[], options: { terminal: TerminalCallbacks }): unknown;
    };
  }
).Bun;
const hasFlowControl = typeof bun?.Terminal?.prototype.pause === "function";

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.kill();
  }
  for (const pid of descendants.splice(0)) {
    killPidIfAlive(pid);
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(args: string[], overrides: Partial<TerminalPtySpawnParams> = {}) {
  const handle = await spawnTerminalPty({
    ...ptyDefaults,
    args,
    env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
    ...overrides,
  });
  handles.push(handle);
  const observed: { output: string; exit?: { exitCode: number; signal?: number } } = { output: "" };
  const exited = createDeferredCore<{ exitCode: number; signal?: number }>();
  let checkOutput: (() => void) | undefined;
  handle.onData((chunk) => {
    observed.output += chunk;
    checkOutput?.();
  });
  handle.onExit((event) => {
    observed.exit = event;
    exited.resolve(event);
  });
  const waitForOutput = async (text: string | RegExp, signal: AbortSignal) => {
    const ready = createDeferredCore();
    checkOutput = () => {
      if (typeof text === "string" ? observed.output.includes(text) : text.test(observed.output)) {
        ready.resolve();
      }
    };
    checkOutput();
    return withinTest(
      awaitGateBeforeSettlement(ready.promise, exited.promise, `PTY exited before ${text}`),
      signal,
    ).finally(() => {
      checkOutput = undefined;
    });
  };
  return { handle, observed, exited: exited.promise, waitForOutput };
}

function shell(script: string, overrides: Partial<TerminalPtySpawnParams> = {}) {
  return start(["-c", script], overrides);
}

async function pausedShell(script: string, cwd: string) {
  const result = await shell(`stty -echo; printf "READY\\n"; read input; ${script}`, { cwd });
  await vi.waitFor(() => expect(result.observed.output).toBe("READY\r\n"), deadline);
  result.handle.pause();
  result.handle.write("go\r");
  return result;
}

// Stock Bun and the current CI pin lack the capability required by the native route.
describe.runIf(Boolean(process.versions.bun) && process.platform !== "win32" && hasFlowControl)(
  "Bun native terminal PTY",
  () => {
    it("preserves cwd, env, terminal input, resize, Unicode, and final output", async () => {
      const cwd = fs.realpathSync(tempDirs.make("openclaw-bun-pty-"));
      const { handle, observed } = await shell(
        'stty -echo; printf "READY\\n"; IFS= read -r input; stty size; printf "%s\\n%s\\n%s\\n%s\\n" "$input" "$PWD" "$TERM" "$PTY_VALUE"; exit 7',
        { cwd, env: { PATH: "/usr/bin:/bin", TERM: "dumb", PWD: "/wrong", PTY_VALUE: "custom" } },
      );
      await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
      handle.resize(101, 37);
      handle.write(Buffer.from("hello 🦞\r"));
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(7), deadline);
      expect(observed.output).toBe(
        `READY\r\n37 101\r\nhello 🦞\r\n${cwd}\r\nxterm-256color\r\ncustom\r\n`,
      );
    });

    it("inherits env without host multiplexer state and preserves an explicit TERM", async () => {
      vi.stubEnv("TMUX", "host-multiplexer");
      vi.stubEnv("TERM", "dumb");
      const { observed } = await shell('printf "%s|%s|%s" "$TMUX" "$TERM" "$PWD"', {
        env: undefined,
        name: "screen-256color",
      });
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
      expect(observed.output).toBe(`|screen-256color|${process.cwd()}`);
    });

    it("Ctrl-C kills the foreground job, not its shell", async ({ signal }) => {
      const { handle, observed, exited, waitForOutput } = await start(
        ["--noprofile", "--norc", "-i"],
        {
          file: "/bin/bash",
          env: { PATH: "/usr/bin:/bin", PS1: "PTY_READY> " },
        },
      );
      await waitForOutput("PTY_READY> ", signal);
      const cwd = tempDirs.make("openclaw-bun-pty-foreground-");
      const foreground = path.join(cwd, "foreground.mjs");
      fs.writeFileSync(
        foreground,
        "setInterval(() => {}, 1000); process.stdout.write(`FOREGROUND:${process.pid}\\n`);",
      );
      const command = [resolveTestNodeExecPath(), foreground].map(quoteCliArg).join(" ");
      handle.write(`stty -echo; ${command}\r`);
      await waitForOutput(/FOREGROUND:\d+\r?\n/u, signal);
      const childPid = Number(observed.output.match(/FOREGROUND:(\d+)\r?\n/u)?.[1]);
      expect(childPid).toBeGreaterThan(0);
      descendants.push(childPid);
      handle.write("\x03");
      handle.write('printf "INTERRUPTED:%s\\n" "$?"\r');
      await waitForOutput("INTERRUPTED:130\r\n", signal);
      expect(isPidAlive(handle.pid)).toBe(true);
      expect(observed.exit).toBeUndefined();
      expect(isPidAlive(childPid)).toBe(false);
      handle.write("exit 0\r");
      expect((await withinTest(exited, signal)).exitCode).toBe(0);
    });

    it("maps signal termination to node-pty's exit code and signal number", async () => {
      const { handle, observed } = await shell('printf "READY\\n"; exec sleep 30');
      await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
      handle.kill("SIGTERM");
      await vi.waitFor(
        () => expect(observed.exit).toEqual({ exitCode: 0, signal: constants.signals.SIGTERM }),
        deadline,
      );
    });

    it("reports root exit before slave EOF, then kills the descendant", async ({ signal }) => {
      const { handle, observed } = await shell(
        'trap \'\' HUP; sleep 30 & printf "CHILD:%s\\n" "$!"; exit 3',
      );
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(3), {
        timeout: 1_000,
        interval: 10,
      });
      const match = observed.output.match(/CHILD:(\d+)/u);
      expect(match).not.toBeNull();
      const childPid = Number(match?.[1]);
      descendants.push(childPid);
      expect(isPidAlive(childPid)).toBe(true);
      handle.kill();
      // Session signaling has no completion promise for an adopted slave-holding child.
      await waitForDead(childPid, signal);
      expect(isPidAlive(childPid)).toBe(false);
    });

    it("stalls child progress while paused and delivers every byte after resume", async () => {
      const cwd = tempDirs.make("openclaw-bun-pty-flow-");
      const payload = "x".repeat(4 * 1024 * 1024);
      fs.writeFileSync(path.join(cwd, "payload"), payload);
      const { handle, observed } = await pausedShell(
        "printf started > progress; cat payload; printf finished > progress",
        cwd,
      );
      const progress = () => fs.readFileSync(path.join(cwd, "progress"), "utf8");
      await vi.waitFor(() => expect(progress()).toBe("started"), deadline);
      let samples = 0;
      await vi.waitFor(
        () => {
          expect(progress()).toBe("started");
          expect(observed.output).toBe("READY\r\n");
          expect(++samples).toBeGreaterThanOrEqual(5);
        },
        { timeout: 1_000, interval: 20 },
      );
      expect(observed.exit).toBeUndefined();
      handle.resume();
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
      expect(progress()).toBe("finished");
      expect(observed.output).toBe(`READY\r\n${payload}`);
    });

    it("preserves the tail when the child finishes while output is paused", async () => {
      const cwd = tempDirs.make("openclaw-bun-pty-tail-");
      const { handle, observed } = await pausedShell(
        'printf "tail 🦞\\n"; : > written; exit 9',
        cwd,
      );
      await vi.waitFor(() => expect(fs.existsSync(path.join(cwd, "written"))).toBe(true), deadline);
      // macOS holds an exiting session leader until its PTY output drains.
      expect(observed).toEqual({ output: "READY\r\n" });
      handle.resume();
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(9), deadline);
      expect(observed.output).toBe("READY\r\ntail 🦞\r\n");
    });

    it("drains on kill despite consumer re-pauses", async ({ signal }) => {
      const cwd = tempDirs.make("openclaw-bun-pty-kill-");
      const payload = path.join(cwd, "payload");
      fs.writeFileSync(payload, "x".repeat(4 * 1024 * 1024));
      // A shell can exit with its killed child's status before the tree kill reaches it.
      const { handle, observed, exited, waitForOutput } = await start([payload], {
        file: "/bin/cat",
        cwd,
      });
      // A viewer whose backlog stays full pauses again on every chunk it receives.
      handle.onData(() => handle.pause());
      await waitForOutput("x", signal);
      expect(observed.exit).toBeUndefined();
      const beforeKill = observed.output.length;
      handle.kill();
      expect(await withinTest(exited, signal)).toEqual({
        exitCode: 0,
        signal: constants.signals.SIGKILL,
      });
      // Teardown delivered the dying tree's output before exit; nothing trails it.
      const atExit = observed.output.length;
      expect(atExit).toBeGreaterThan(beforeKill);
      handle.resume();
      expect(observed.output.length).toBe(atExit);
    });
  },
);

// Drives the native adapter through controlled Bun.spawn terminal callbacks.
function spawnControlledBunPty() {
  const runtime = bun ?? { spawn: vi.fn() };
  if (!bun) {
    vi.stubGlobal("Bun", runtime);
  }
  const terminal = {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const done = createDeferredCore<number>();
  const spawn = vi.spyOn(runtime, "spawn").mockReturnValue({
    pid: 1234,
    terminal,
    exited: done.promise,
    exitCode: 7,
    signalCode: null,
    kill: vi.fn(),
  });
  const handle = bunAdapter.spawnBunTerminalPty({
    ...ptyDefaults,
    env: {},
    name: "xterm-256color",
  });
  const callbacks = spawn.mock.calls[0]?.[1]?.terminal;
  if (!callbacks) {
    throw new Error("Bun.spawn did not receive terminal callbacks");
  }
  return { handle, callbacks, terminal, done };
}

it.each([false, true])(
  "settles queued output before exit with subscriber=%s",
  async (subscribed) => {
    const { handle, callbacks, terminal, done } = spawnControlledBunPty();
    const events: string[] = [];
    const chunks = subscribed ? ["early 🦞\r\n", "two\r\n", "three\r\n"] : ["unobserved\r\n"];
    handle.onExit(({ exitCode }) => events.push(`exit:${exitCode}`));
    for (const chunk of chunks) {
      callbacks.data(terminal, new TextEncoder().encode(chunk));
    }
    expect(events).toEqual([]);
    if (subscribed) {
      handle.onData((chunk) => {
        events.push(chunk);
        if (events.length === 1) {
          handle.pause();
        }
      });
      expect(events).toEqual(["early 🦞\r\n"]);
    }
    callbacks.exit(terminal);
    done.resolve(7);
    await done.promise;
    if (subscribed) {
      expect(events).toEqual(["early 🦞\r\n"]);
      expect(terminal.close).not.toHaveBeenCalled();
      handle.resume();
      expect(events).toEqual(["early 🦞\r\n", "two\r\n", "three\r\n", "exit:7"]);
      expect(terminal.close).toHaveBeenCalledOnce();
      handle.resume();
      expect(events).toEqual(["early 🦞\r\n", "two\r\n", "three\r\n", "exit:7"]);
    } else {
      expect(events).toEqual(["exit:7"]);
      handle.onData((chunk) => events.push(chunk));
      expect(events).toEqual(["exit:7"]);
    }
  },
);

it.runIf(Boolean(process.versions.bun) && process.platform !== "win32" && !hasFlowControl)(
  "runs stock Bun terminals through the real Node helper",
  async () => {
    const helper = vi.spyOn(nodeAdapter, "spawnNodeTerminalPty");
    const { exited, observed } = await shell('printf "helper-output"; exit 7');
    expect((await exited).exitCode).toBe(7);
    expect(helper).toHaveBeenCalledOnce();
    expect(observed.output).toBe("helper-output");
  },
);
