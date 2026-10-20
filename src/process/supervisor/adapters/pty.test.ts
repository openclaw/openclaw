import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { ProcessExtinctionResult } from "../types.js";
import {
  expectRealExitWinsOverSigkillFallback,
  expectWaitStaysPendingUntilSigkillFallback,
  mockLinuxOomWrapperShell,
} from "./test-support.js";

const { spawnMock, ptyKillMock, signalProcessTreeMock, signalPtySessionTreeMock } = vi.hoisted(
  () => ({
    spawnMock:
      vi.fn<
        (
          ...args: Parameters<typeof import("../../terminal-pty.js").spawnTerminalPty>
        ) => ReturnType<typeof createStubPty> | Promise<ReturnType<typeof createStubPty>>
      >(),
    ptyKillMock: vi.fn(),
    signalProcessTreeMock: vi.fn(),
    signalPtySessionTreeMock: vi.fn(),
  }),
);

vi.mock("../../terminal-pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../terminal-pty.js")>()),
  spawnTerminalPty: spawnMock,
}));

vi.mock("../../kill-tree.js", () => ({
  signalProcessTree: (...args: unknown[]) => signalProcessTreeMock(...args),
  signalPtySessionTree: (...args: unknown[]) => signalPtySessionTreeMock(...args),
}));

function createStubPty(pid = 1234) {
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const disposeData = vi.fn();
  const disposeExit = vi.fn();
  return {
    pid,
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: disposeData })),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
      return { dispose: disposeExit };
    }),
    kill: (signal?: string) => ptyKillMock(signal),
    emitExit: (event: { exitCode: number; signal?: number }) => {
      exitListener?.(event);
    },
    disposeData,
    disposeExit,
  };
}

const expectSpawnOptions = () => spawnMock.mock.calls[0]![0];

describe("createPtyAdapter", () => {
  let createPtyAdapter: typeof import("./pty.js").createPtyAdapter;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { value, configurable: true });
  const start = (params: Partial<Parameters<typeof createPtyAdapter>[0]> = {}) =>
    createPtyAdapter({ shell: "bash", args: ["-lc", "sleep 10"], ...params });
  async function setup(params: Parameters<typeof start>[0] = {}) {
    const stub = createStubPty();
    spawnMock.mockReturnValue(stub);
    return { stub, adapter: await start(params) };
  }

  beforeAll(async () => {
    ({ createPtyAdapter } = await import("./pty.js"));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([false, true])("aborts construction (spawned=%s)", async (spawned) => {
    const abort = new AbortController();
    const pending = createDeferredCore<ReturnType<typeof createStubPty>>();
    const stub = createStubPty();
    spawnMock.mockReturnValue(spawned ? pending.promise : stub);
    const starting = start({ args: ["-lc", "echo started"], abortSignal: abort.signal });
    if (spawned) {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    }
    abort.abort();
    if (spawned) {
      pending.resolve(stub);
    }
    await expect(starting).rejects.toThrow("PTY construction aborted");
    if (spawned) {
      expect(ptyKillMock).toHaveBeenCalledOnce();
    } else {
      expect(spawnMock).not.toHaveBeenCalled();
    }
  });

  it("prefers the explicit child TERM without merging the Windows ambient env", async () => {
    setPlatform("win32");
    vi.stubEnv("TERM", "ambient-term");
    vi.stubEnv("OPENCLAW_PTY_TEST_SENTINEL", "ambient");
    await setup({
      shell: "powershell.exe",
      args: ["-NoLogo"],
      env: { Term: "screen-256color", ONLY_CHILD: "yes" },
    });

    expect(expectSpawnOptions()).toMatchObject({
      name: "screen-256color",
      env: { TERM: "screen-256color", ONLY_CHILD: "yes" },
    });
    expect(expectSpawnOptions().env).not.toHaveProperty("Term");
    expect(expectSpawnOptions().env).not.toHaveProperty("OPENCLAW_PTY_TEST_SENTINEL");
  });

  it("forwards non-SIGTERM explicit signals to node-pty kill on non-Windows", async () => {
    setPlatform("darwin");
    const { adapter } = await setup();
    adapter.kill("SIGINT");
    expect(ptyKillMock).toHaveBeenCalledWith("SIGINT");
    expect(signalProcessTreeMock).not.toHaveBeenCalled();
  });

  it("keeps terminal fallback distinct from unconfirmed PTY cleanup", async () => {
    vi.useFakeTimers();
    const onSpawnCleanup = vi.fn<(cleanup: Promise<ProcessExtinctionResult>) => void>();
    const { adapter } = await setup({ onSpawnCleanup });

    await expectWaitStaysPendingUntilSigkillFallback(adapter.wait(), () => adapter.kill());
    expect(onSpawnCleanup).toHaveBeenCalledOnce();
    await expect(onSpawnCleanup.mock.calls[0]![0]).rejects.toThrow(
      "cleanup could not be confirmed",
    );
  });

  it("prefers real PTY exit over SIGKILL fallback settle", async () => {
    vi.useFakeTimers();
    const { stub, adapter } = await setup();

    await expectRealExitWinsOverSigkillFallback({
      waitPromise: adapter.wait(),
      triggerKill: () => adapter.kill(),
      emitExit: () => stub.emitExit({ exitCode: 0, signal: 9 }),
      expected: { code: 0, signal: 9 },
    });
  });

  it.each([true, false])(
    "preserves the first PTY exit across waits (waitBefore=%s)",
    async (waitBefore) => {
      const { stub, adapter } = await setup({ args: ["-lc", "exit 3"] });

      expect(stub.onExit).toHaveBeenCalledTimes(1);
      const pending = waitBefore ? [adapter.wait(), adapter.wait()] : [];
      stub.emitExit({ exitCode: 3, signal: 0 });
      const result = await adapter.wait();
      expect(result).toStrictEqual({ code: 3, signal: null });
      expect(adapter.stdin).toMatchObject({ destroyed: true, writable: false });
      stub.emitExit({ exitCode: 9, signal: 15 });
      adapter.dispose();
      for (const wait of [...pending, adapter.wait()]) {
        await expect(wait).resolves.toBe(result);
      }
    },
  );

  it("reports stdin as non-writable after EOF or dispose", async () => {
    const { stub, adapter } = await setup({ args: ["-lc", "cat"] });

    expect(adapter.stdin).toMatchObject({ writable: true, writableEnded: false });

    adapter.stdin?.end();
    expect(stub.write).toHaveBeenCalledWith(process.platform === "win32" ? "\x1a" : "\x04");
    expect(adapter.stdin).toMatchObject({ writable: false, writableEnded: true });

    adapter.dispose();
    expect(adapter.stdin?.destroyed).toBe(true);
  });

  it("surfaces a backend EOF write failure", async () => {
    const stub = createStubPty();
    const failure = new Error("write EIO");
    stub.write.mockImplementation(() => {
      throw failure;
    });
    spawnMock.mockReturnValue(stub);
    const adapter = await start({ args: ["-lc", "cat"] });

    try {
      expect(() => adapter.stdin?.end()).toThrow(failure);
      expect(adapter.stdin?.writable).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it("disposes PTY listeners", async () => {
    const { stub, adapter } = await setup({ args: ["-lc", "echo ok"] });
    adapter.onStdout(() => undefined);
    const pending = adapter.wait();

    adapter.dispose();

    const result = await pending;
    expect(result).toStrictEqual({ code: null, signal: null });
    await expect(adapter.wait()).resolves.toBe(result);
    expect(stub.disposeData).toHaveBeenCalledTimes(1);
    expect(stub.disposeExit).toHaveBeenCalledTimes(1);
  });

  it("wraps Linux PTY spawns so shell children inherit higher OOM score", async () => {
    setPlatform("linux");
    using shell = { [Symbol.dispose]: mockLinuxOomWrapperShell() };
    void shell;
    vi.resetModules();
    const { createPtyAdapter: createLinuxPtyAdapter } = await import("./pty.js");
    spawnMock.mockReturnValue(createStubPty());
    const adapter = await createLinuxPtyAdapter({
      shell: "bash",
      args: ["-lc", "env"],
      env: { PATH: "/usr/bin", BASH_ENV: "/tmp/bashenv", TERM: "dumb" },
    });
    expect(adapter.oomScoreWrapperSelected).toBe(true);

    expect(expectSpawnOptions().file).toBe("/bin/sh");
    expect(expectSpawnOptions().args).toEqual([
      "-c",
      'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
      "bash",
      "-lc",
      "env",
    ]);
    expect(expectSpawnOptions().env).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color" });
  });

  it("passes explicit env overrides as strings", async () => {
    await setup({
      args: ["-lc", "env"],
      name: "xterm-256color",
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    expect(expectSpawnOptions().env).toEqual({ FOO: "bar", COUNT: "12", TERM: "xterm-256color" });
  });

  it("uses process-tree kill for SIGKILL on Windows", async () => {
    setPlatform("win32");
    spawnMock.mockReturnValue(createStubPty(4567));
    const adapter = await start({ shell: "powershell.exe", args: ["-NoLogo"] });
    adapter.kill("SIGKILL");
    expect(signalPtySessionTreeMock).toHaveBeenCalledWith(4567, "SIGKILL");
    expect(signalProcessTreeMock).not.toHaveBeenCalled();
    expect(ptyKillMock).not.toHaveBeenCalled();
  });
});
