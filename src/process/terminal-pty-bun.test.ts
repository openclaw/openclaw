import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
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
    file: "/bin/sh",
    args,
    env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
    cols: 80,
    rows: 24,
    ...overrides,
  });
  handles.push(handle);
  const observed: { output: string; exit?: { exitCode: number; signal?: number } } = { output: "" };
  handle.onData((chunk) => {
    observed.output += chunk;
  });
  handle.onExit((event) => {
    observed.exit = event;
  });
  return { handle, observed };
}

// Stock Bun and the current CI pin lack the capability required by the native route.
describe.runIf(Boolean(process.versions.bun) && process.platform !== "win32" && hasFlowControl)(
  "Bun native terminal PTY (requires Bun on POSIX with Terminal.pause/resume)",
  () => {
    it("preserves cwd, env, terminal input, resize, Unicode, and final output", async () => {
      const cwd = fs.realpathSync(tempDirs.make("openclaw-bun-pty-"));
      const { handle, observed } = await start(
        [
          "-c",
          'stty -echo; printf "READY\\n"; IFS= read -r input; stty size; printf "%s\\n%s\\n%s\\n%s\\n" "$input" "$PWD" "$TERM" "$PTY_VALUE"; exit 7',
        ],
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
      const { observed } = await start(["-c", 'printf "%s|%s|%s" "$TMUX" "$TERM" "$PWD"'], {
        env: undefined,
        name: "screen-256color",
      });
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
      expect(observed.output).toBe(`|screen-256color|${process.cwd()}`);
    });

    it("Ctrl-C interrupts the foreground job while the interactive shell survives", async () => {
      const { handle, observed } = await start(["--noprofile", "--norc", "-i"], {
        file: "/bin/bash",
        env: { PATH: "/usr/bin:/bin", PS1: "PTY_READY> " },
      });
      await vi.waitFor(() => expect(observed.output).toContain("PTY_READY> "), deadline);
      handle.write("stty -echo; sleep 30\r");
      let childPid = 0;
      await vi.waitFor(() => {
        const rows = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout;
        const child = rows
          .split("\n")
          .map((line) => line.trim().split(/\s+/u))
          .find(
            ([, parent, command]) => Number(parent) === handle.pid && command?.endsWith("sleep"),
          );
        expect(child).toBeDefined();
        childPid = Number(child?.[0]);
      }, deadline);
      descendants.push(childPid);
      handle.write("\x03");
      handle.write('printf "INTERRUPTED:%s\\n" "$?"\r');
      await vi.waitFor(() => expect(observed.output).toContain("INTERRUPTED:130\r\n"), deadline);
      expect(isPidAlive(handle.pid)).toBe(true);
      expect(observed.exit).toBeUndefined();
      await vi.waitFor(() => expect(isPidAlive(childPid)).toBe(false), deadline);
      handle.write("exit 0\r");
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
    });

    it("maps signal termination to node-pty's exit code and signal number", async () => {
      const { handle, observed } = await start(["-c", 'printf "READY\\n"; exec sleep 30']);
      await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
      handle.kill("SIGTERM");
      await vi.waitFor(
        () => expect(observed.exit).toEqual({ exitCode: 0, signal: constants.signals.SIGTERM }),
        deadline,
      );
    });

    it("reports shell exit promptly with a slave-holding descendant and still kills that descendant", async () => {
      const { handle, observed } = await start([
        "-c",
        'trap \'\' HUP; sleep 30 & printf "CHILD:%s\\n" "$!"; exit 3',
      ]);
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
      await vi.waitFor(() => expect(isPidAlive(childPid)).toBe(false), deadline);
    });

    describe("flow control", () => {
      it("stalls child progress while paused and delivers every byte after resume", async () => {
        const cwd = tempDirs.make("openclaw-bun-pty-flow-");
        const payload = "x".repeat(4 * 1024 * 1024);
        fs.writeFileSync(path.join(cwd, "payload"), payload);
        const { handle, observed } = await start(
          [
            "-c",
            'stty -echo; printf "READY\\n"; read input; printf started > progress; cat payload; printf finished > progress',
          ],
          { cwd },
        );
        await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
        handle.pause();
        handle.write("go\r");
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
        const { handle, observed } = await start(
          [
            "-c",
            'stty -echo; printf "READY\\n"; read input; printf "tail 🦞\\n"; : > written; exit 9',
          ],
          { cwd },
        );
        await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
        handle.pause();
        handle.write("go\r");
        await vi.waitFor(
          () => expect(fs.existsSync(path.join(cwd, "written"))).toBe(true),
          deadline,
        );
        // macOS holds an exiting session leader until its PTY output drains.
        expect(observed.output).toBe("READY\r\n");
        expect(observed.exit).toBeUndefined();
        handle.resume();
        await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(9), deadline);
        expect(observed.output).toBe("READY\r\ntail 🦞\r\n");
      });

      it("reports exit after kill while the consumer keeps re-pausing output", async () => {
        const cwd = tempDirs.make("openclaw-bun-pty-kill-");
        fs.writeFileSync(path.join(cwd, "payload"), "x".repeat(4 * 1024 * 1024));
        const { handle, observed } = await start(
          [
            "-c",
            'stty -echo; printf "READY\\n"; read input; printf started > progress; cat payload',
          ],
          { cwd },
        );
        await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
        handle.pause();
        handle.write("go\r");
        await vi.waitFor(
          () => expect(fs.readFileSync(path.join(cwd, "progress"), "utf8")).toBe("started"),
          deadline,
        );
        // A viewer whose backlog stays full pauses again on every chunk it receives.
        handle.onData(() => handle.pause());
        handle.kill();
        await vi.waitFor(
          () => expect(observed.exit).toEqual({ exitCode: 0, signal: constants.signals.SIGKILL }),
          deadline,
        );
        // Teardown delivered the dying tree's output before exit; nothing trails it.
        const atExit = observed.output.length;
        expect(atExit).toBeGreaterThan("READY\r\n".length);
        handle.resume();
        expect(observed.output.length).toBe(atExit);
      });
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
  let callbacks: TerminalCallbacks | undefined;
  vi.spyOn(runtime, "spawn").mockImplementation(
    (_argv: string[], options: { terminal: TerminalCallbacks }) => {
      callbacks = options.terminal;
      return {
        pid: 1234,
        terminal,
        exited: done.promise,
        exitCode: 7,
        signalCode: null,
        kill: vi.fn(),
      };
    },
  );
  const handle = bunAdapter.spawnBunTerminalPty({
    file: "/bin/sh",
    args: [],
    env: {},
    name: "xterm-256color",
    cols: 80,
    rows: 24,
  });
  if (!callbacks) {
    throw new Error("Bun.spawn did not receive terminal callbacks");
  }
  return { handle, callbacks, terminal, done };
}

it("replays queued chunks in order, honors a listener pause, and delivers exit last", async () => {
  const { handle, callbacks, terminal, done } = spawnControlledBunPty();
  const events: string[] = [];
  handle.onExit(({ exitCode }) => events.push(`exit:${exitCode}`));
  for (const chunk of ["early 🦞\r\n", "two\r\n", "three\r\n"]) {
    callbacks.data(terminal, new TextEncoder().encode(chunk));
  }
  expect(events).toEqual([]);
  handle.onData((chunk) => {
    events.push(chunk);
    if (events.length === 1) {
      handle.pause();
    }
  });
  expect(events).toEqual(["early 🦞\r\n"]);
  callbacks.exit(terminal);
  done.resolve(7);
  await done.promise;
  expect(events).toEqual(["early 🦞\r\n"]);
  expect(terminal.close).not.toHaveBeenCalled();
  handle.resume();
  expect(events).toEqual(["early 🦞\r\n", "two\r\n", "three\r\n", "exit:7"]);
  expect(terminal.close).toHaveBeenCalledOnce();
  handle.resume();
  expect(events).toEqual(["early 🦞\r\n", "two\r\n", "three\r\n", "exit:7"]);
});

it("never delivers unsubscribed output after exit", async () => {
  const { handle, callbacks, terminal, done } = spawnControlledBunPty();
  const events: string[] = [];
  handle.onExit(({ exitCode }) => events.push(`exit:${exitCode}`));
  callbacks.data(terminal, new TextEncoder().encode("unobserved\r\n"));
  callbacks.exit(terminal);
  done.resolve(7);
  await done.promise;
  expect(events).toEqual(["exit:7"]);
  handle.onData((chunk) => events.push(chunk));
  expect(events).toEqual(["exit:7"]);
});

it.each([false, true])("routes Bun PTYs with Terminal.pause=%s", async (flowControl) => {
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: "1.4.2" });
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const prototype = bun?.Terminal?.prototype ?? {};
  const pause = Object.getOwnPropertyDescriptor(prototype, "pause");
  if (!bun) {
    vi.stubGlobal("Bun", { Terminal: { prototype } });
  }
  Object.defineProperty(prototype, "pause", {
    ...(pause ?? { configurable: true, writable: true }),
    value: flowControl ? () => {} : undefined,
  });
  try {
    const handle: TerminalPtyHandle = {
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
    };
    const native = vi.spyOn(bunAdapter, "spawnBunTerminalPty").mockReturnValue(handle);
    const helper = vi.spyOn(nodeAdapter, "spawnNodeTerminalPty").mockResolvedValue(handle);
    const assertCurrent = vi.fn();
    const params = {
      file: "/bin/sh",
      args: [],
      env: { TERM: "dumb", PWD: "/original" },
      cwd: "/workspace",
      cols: 80,
      rows: 24,
    };
    expect(await spawnTerminalPty(params, { assertCurrent })).toBe(handle);
    expect(assertCurrent).toHaveBeenCalledOnce();
    if (flowControl) {
      expect(helper).not.toHaveBeenCalled();
      expect(native).toHaveBeenCalledWith({
        ...params,
        name: "xterm-256color",
        env: { TERM: "xterm-256color", PWD: "/workspace" },
      });
    } else {
      expect(native).not.toHaveBeenCalled();
      expect(helper).toHaveBeenCalledWith(params, expect.any(Function));
      expect(helper.mock.calls[0]?.[0]).toBe(params);
      helper.mock.calls[0]?.[1]?.();
      expect(assertCurrent).toHaveBeenCalledTimes(2);
    }
    expect(params.env).toEqual({ TERM: "dumb", PWD: "/original" });
  } finally {
    if (pause) {
      Object.defineProperty(prototype, "pause", pause);
    } else {
      delete prototype.pause;
    }
  }
});

it.runIf(Boolean(process.versions.bun) && process.platform !== "win32" && !hasFlowControl)(
  "runs stock Bun terminals through the real Node helper",
  async () => {
    const helper = vi.spyOn(nodeAdapter, "spawnNodeTerminalPty");
    const done = createDeferredCore<number>();
    const { handle, observed } = await start(["-c", 'printf "helper-output"; exit 7']);
    handle.onExit(({ exitCode }) => done.resolve(exitCode));
    expect(await done.promise).toBe(7);
    expect(helper).toHaveBeenCalledOnce();
    expect(observed.output).toBe("helper-output");
  },
);
