import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { closeOwnedStdioProcess } from "../../owned-stdio.js";
import type { ProcessExtinctionResult } from "../types.js";
import {
  createChildAdapterHarness,
  createStubChild,
  createWindowsNpmShim,
  firstSpawnWithFallbackParams,
  readyChildAdapter,
  setPlatform,
} from "./child.test-support.js";
import {
  expectWaitStaysPendingUntilSigkillFallback,
  mockLinuxOomWrapperShell,
} from "./test-support.js";

const { spawnMock, signalMock, killTreeMock, decoderMock, relayMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn<typeof import("../../kill-tree.js").signalProcessTree>(),
  killTreeMock: vi.fn<typeof import("../../kill-tree.js").killProcessTree>(),
  decoderMock:
    vi.fn<typeof import("../../../infra/windows-encoding.js").createWindowsOutputDecoder>(),
  relayMock: vi.fn(),
}));
vi.mock("../../spawn-utils.js", () => ({ spawnWithFallback: spawnMock }));
vi.mock("../../kill-tree.js", () => ({
  signalProcessTree: signalMock,
  killProcessTree: killTreeMock,
}));
vi.mock("../../../infra/windows-encoding.js", () => ({ createWindowsOutputDecoder: decoderMock }));
vi.mock("../service-child-relay-host.js", () => ({ createServiceChildRelayAdapter: relayMock }));

if (process.platform !== "win32") {
  createRequire(import.meta.url)("koffi");
}

let start: ReturnType<typeof readyChildAdapter>;
let roots: typeof import("../../../infra/windows-install-roots.js").getWindowsInstallRoots;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const decode = (chunk: Buffer | string) =>
  Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
type Input = Partial<
  Omit<Parameters<typeof start>[0], "anchoredShellCommand" | "stdoutConsumption">
>;
function createSecretChild(secret: Writable) {
  const child = createStubChild();
  Object.defineProperty(child.child, "stdio", {
    value: [child.child.stdin, child.child.stdout, child.child.stderr, secret],
    configurable: true,
  });
  spawnMock.mockResolvedValue({ child: child.child, usedFallback: false });
  return child;
}
function setup(input: Input = {}, usedFallback = false) {
  const { argv = ["node", "worker"], ...options } = input;
  return createChildAdapterHarness(
    (params) => start({ ...params, ...options }),
    {
      mockResolvedValue(
        spawned: Awaited<ReturnType<typeof import("../../spawn-utils.js").spawnWithFallback>>,
      ) {
        return spawnMock.mockResolvedValue({ ...spawned, usedFallback });
      },
    },
    { argv },
  );
}

const spawnArgs = () => firstSpawnWithFallbackParams(spawnMock);

beforeEach(async () => {
  vi.resetModules();
  const access = fs.accessSync.bind(fs);
  vi.spyOn(fs, "accessSync").mockImplementation((file, mode) => {
    if (String(file).toLowerCase() === "c:\\windows\\system32\\reg.exe") {
      throw new Error("registry lookup disabled for test");
    }
    return access(file, mode);
  });
  ({ getWindowsInstallRoots: roots } = await import("../../../infra/windows-install-roots.js"));
  start = readyChildAdapter((await import("./child.js")).createChildAdapter);
  spawnMock.mockReset();
  signalMock.mockReset().mockImplementation((_pid, _signal, options) => options?.onComplete?.());
  killTreeMock.mockReset();
  decoderMock.mockReset().mockImplementation(() => ({ decode, flush: () => "" }));
  relayMock.mockReset().mockResolvedValue({ ready: Promise.resolve(), adapter: {} });
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
});

it("creates owned worker groups without fallback and gates startup through IPC", async () => {
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "service-managed");
  const { adapter, sendMock, disconnectMock } = await setup({ ownedWorker: true, input: "{}" });
  expect(spawnArgs().options?.detached).toBe(process.platform !== "win32");
  expect(spawnArgs().fallbacks).toEqual([]);
  expect(spawnArgs().options?.stdio).toEqual(["pipe", "pipe", "pipe", "ipc"]);
  await adapter.openStartGate?.();
  expect(sendMock).toHaveBeenCalledWith({ type: "openclaw-worker-start-v1" }, expect.any(Function));
  adapter.closeStartGate?.();
  expect(disconnectMock).toHaveBeenCalledOnce();
});

it("joins worker exit, closed pipes and the queued IPC disconnect", async () => {
  vi.useFakeTimers();
  setPlatform("darwin");
  const { adapter, child, disconnectMock, emitExit } = await setup({ ownedWorker: true });
  disconnectMock.mockImplementation(() => {
    Object.defineProperty(child, "connected", { value: false });
  });
  const settled = vi.fn();
  void adapter.wait().then(settled);
  adapter.closeStartGate?.();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.emit("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    stream?.emit("close");
  }
  emitExit(7);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();
  child.emit("disconnect");
  await expect(adapter.wait()).resolves.toEqual({ code: 7, signal: null });
  expect(signalMock).not.toHaveBeenCalled();
  adapter.dispose();
});

it("keeps ordinary children supervised through repeated operational errors", async () => {
  const { adapter, child, emitExit, emitClose } = await setup();
  const settled = vi.fn();
  void adapter.wait().then(settled, settled);
  for (let attempt = 0; attempt < 2; attempt++) {
    child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  }
  emitExit(0);
  child.stdout?.emit("close");
  child.stderr?.emit("close");
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  emitClose(0);
  await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  adapter.dispose();
});

it.each(["error", "close"])(
  "retains the first worker %s outcome for early and late waits",
  async (first) => {
    const { adapter, child, emitClose, disconnectMock } = await setup({ ownedWorker: true });
    const error = new Error("kill EPERM");
    const pending = first === "close" ? adapter.wait() : undefined;
    if (first === "error") {
      child.emit("error", error);
      emitClose(0);
    } else {
      emitClose(0);
      child.emit("error", error);
    }
    await nextTurn();
    if (first === "error") {
      await expect(adapter.wait()).rejects.toBe(error);
    } else {
      const result = await pending;
      expect(result).toEqual({ code: 0, signal: null });
      expect(await adapter.wait()).toBe(result);
    }
    adapter.dispose();
    expect(disconnectMock).toHaveBeenCalledOnce();
  },
);

it("delivers a secret through an overlapped descriptor and zeroes the buffer", async () => {
  setPlatform("win32");
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  createSecretChild(stream);
  const transient = Buffer.from("selected-secret");
  await start({ argv: ["claude", "-p"], secretInput: { fd: 3, createData: () => transient } });
  expect(spawnArgs().options?.stdio).toEqual(["inherit", "pipe", "pipe", "overlapped"]);
  expect(Buffer.concat(chunks).toString()).toBe("selected-secret");
  expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
});

it("captures close while secret delivery is still pending", async () => {
  setPlatform("win32");
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      child.emitClose(0);
      setImmediate(callback);
    },
  });
  const child = createSecretChild(stream);
  const adapter = await start({
    argv: ["claude", "-p"],
    secretInput: { fd: 3, createData: () => Buffer.from("selected-secret") },
  });
  await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
});

it("keeps macOS no-detach TERM on the direct signal path", async () => {
  setPlatform("darwin");
  const { adapter, killMock, child } = await setup({}, true);
  adapter.kill("SIGTERM");
  expect(signalMock).toHaveBeenCalledWith(child.pid, "SIGTERM", { detached: false });
  expect(killMock).not.toHaveBeenCalled();
});

it("retains one Linux fallback snapshot through root close and disposal", async () => {
  setPlatform("linux");
  const force = vi.fn();
  killTreeMock.mockReturnValue({ force });
  const { adapter, child, emitExit, emitClose } = await setup({}, true);
  adapter.kill("SIGTERM");
  adapter.kill("SIGTERM");
  expect(killTreeMock).toHaveBeenCalledExactlyOnceWith(child.pid, {
    detached: false,
    graceMs: 5_000,
    force: false,
  });
  emitExit(0);
  emitClose(0);
  await adapter.wait();
  adapter.dispose();
  adapter.kill("SIGKILL");
  expect(force).toHaveBeenCalledOnce();
  expect(killTreeMock).toHaveBeenCalledOnce();
  expect(signalMock).not.toHaveBeenCalled();
});

it("never rediscovers a Linux fallback tree without its initial identity", async () => {
  setPlatform("linux");
  const { adapter, killMock } = await setup({}, true);
  adapter.kill("SIGTERM");
  adapter.kill("SIGKILL");
  await Promise.resolve();
  expect(killTreeMock).toHaveBeenCalledOnce();
  expect(signalMock).not.toHaveBeenCalled();
  expect(killMock).toHaveBeenCalledWith("SIGKILL");
});

it("does not discover a Linux fallback tree after root exit", async () => {
  setPlatform("linux");
  const { adapter, emitExit } = await setup({}, true);
  emitExit(0);
  adapter.kill("SIGTERM");
  adapter.kill("SIGKILL");
  await Promise.resolve();
  expect(killTreeMock).not.toHaveBeenCalled();
  expect(signalMock).not.toHaveBeenCalled();
});

it("uses an immediate identity-bound kill for a live Linux fallback root", async () => {
  setPlatform("linux");
  const { adapter, child } = await setup({}, true);
  adapter.kill("SIGKILL");
  await Promise.resolve();
  expect(killTreeMock).toHaveBeenCalledExactlyOnceWith(child.pid, {
    detached: false,
    graceMs: 5_000,
    force: true,
  });
  expect(signalMock).not.toHaveBeenCalled();
});

it("rejects writes after stdin ends and tracks destruction", async () => {
  const { adapter } = await setup();
  expect(adapter.stdin?.writable).toBe(true);
  expect(adapter.stdin?.writableEnded).toBe(false);
  adapter.stdin?.end();
  expect(adapter.stdin?.writable).toBe(false);
  expect(adapter.stdin?.writableEnded).toBe(true);
  const callback = vi.fn();
  adapter.stdin?.write("late", callback);
  expect(callback).toHaveBeenCalledWith(expect.any(Error));
  adapter.stdin?.destroy?.();
  expect(adapter.stdin?.destroyed).toBe(true);
});

it("detaches only decoder-owned listeners after the kill fallback", async () => {
  vi.useFakeTimers();
  const flush = vi.fn(() => "flushed tail");
  decoderMock.mockImplementation(() => ({ decode: (chunk) => `decoded:${decode(chunk)}`, flush }));
  const { adapter, child } = await setup();
  const stdout = vi.fn(),
    stderr = vi.fn(),
    stdoutClose = vi.fn(),
    stderrClose = vi.fn();
  child.stdout?.on("close", stdoutClose);
  child.stderr?.on("close", stderrClose);
  adapter.onStdout(stdout);
  adapter.onStderr(stderr);
  child.stdout?.emit("data", Buffer.from("drained stdout"));
  child.stderr?.emit("data", Buffer.from("drained stderr"));
  expect(stdout).toHaveBeenCalledExactlyOnceWith("decoded:drained stdout");
  expect(stderr).toHaveBeenCalledExactlyOnceWith("decoded:drained stderr");
  await expectWaitStaysPendingUntilSigkillFallback(adapter.wait(), () => adapter.kill());
  const error = new Error("queued output error");
  child.stderr!.destroy(error);
  adapter.dispose();
  expect(child.stdout!.destroyed).toBe(true);
  expect(child.stderr!.destroyed).toBe(true);
  expect(child.stderr!.errored).toBe(error);
  child.stdout!.emit("data", Buffer.from("late stdout"));
  child.stderr!.emit("data", Buffer.from("late stderr"));
  await vi.runAllTimersAsync();
  expect(stdout).toHaveBeenCalledOnce();
  expect(stderr).toHaveBeenCalledOnce();
  expect(flush).not.toHaveBeenCalled();
  expect(stdoutClose).toHaveBeenCalledOnce();
  expect(stderrClose).toHaveBeenCalledOnce();
});

it("does not renew Windows cleanup deadlines or invent extinction on repeated KILL", async () => {
  vi.useFakeTimers();
  setPlatform("win32");
  signalMock.mockImplementationOnce(() => {}).mockImplementationOnce(() => {});
  const { adapter } = await setup();
  const settled = vi.fn();
  void adapter.wait().then(settled);
  const rejected = expect(closeOwnedStdioProcess(adapter, { force: true })).rejects.toThrow(
    "before the kill deadline",
  );
  await vi.advanceTimersByTimeAsync(3_000);
  adapter.kill("SIGKILL");
  await vi.advanceTimersByTimeAsync(999);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledExactlyOnceWith({ code: null, signal: "SIGKILL" });
  await rejected;
  adapter.kill("SIGKILL");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(settled).toHaveBeenCalledOnce();
  await expect(adapter.waitForExtinction!()).rejects.toThrow("before the kill deadline");
  adapter.dispose();
});

it.each(["open", "closed", "drained"] as const)(
  "joins Windows tree kill before settling %s streams",
  async (streams) => {
    vi.useFakeTimers();
    setPlatform("win32");
    let complete: (() => void) | undefined;
    signalMock.mockImplementationOnce((_pid, _signal, options) => {
      complete = options?.onComplete;
    });
    const { adapter, child, emitExit, emitClose } = await setup({
      stdinMode: "pipe-closed",
      ...(streams === "drained" ? { ownedWorker: true } : {}),
    });
    const settled = vi.fn();
    void adapter.wait().then(settled);
    adapter.kill("SIGKILL");
    adapter.closeStartGate?.();
    emitExit(null, "SIGKILL");
    if (streams === "closed") {
      emitClose(null, "SIGKILL");
    }
    if (streams === "drained") {
      child.stdout?.emit("end");
      child.stderr?.emit("end");
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    expect(child.stdout?.destroyed).toBe(false);
    expect(child.stderr?.destroyed).toBe(false);
    complete?.();
    await vi.advanceTimersByTimeAsync(0);
    if (streams === "open") {
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.stdout?.destroyed).toBe(true);
      expect(child.stderr?.destroyed).toBe(true);
    }
    expect(settled).toHaveBeenCalledWith({ code: null, signal: "SIGKILL" });
  },
);

it("preserves descendant output after ordinary Windows exit", async () => {
  vi.useFakeTimers();
  setPlatform("win32");
  const { adapter, emitExit, child } = await setup({ stdinMode: "pipe-closed" });
  const stdout = vi.fn(),
    stderr = vi.fn(),
    settled = vi.fn();
  adapter.onStdout(stdout);
  adapter.onStderr(stderr);
  void adapter.wait().then(settled);
  emitExit(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(settled).not.toHaveBeenCalled();
  expect(child.stdout?.destroyed).toBe(false);
  expect(child.stderr?.destroyed).toBe(false);
  child.stdout?.emit("data", Buffer.from("late stdout"));
  child.stderr?.emit("data", Buffer.from("late stderr"));
  child.stdout?.emit("end");
  child.stderr?.emit("end");
  await vi.runAllTimersAsync();
  expect(stdout).toHaveBeenCalledWith("late stdout");
  expect(stderr).toHaveBeenCalledWith("late stderr");
  expect(settled).toHaveBeenCalledWith({ code: 0, signal: null });
});

it("wraps Windows command shims through trusted cmd.exe", async () => {
  setPlatform("win32");
  await setup({ argv: ["pnpm", "--version"], env: { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" } });
  expect(spawnArgs().argv).toEqual([
    path.win32.join(roots().systemRoot, "System32", "cmd.exe"),
    "/d",
    "/s",
    "/c",
    '""pnpm.cmd" "--version""',
  ]);
  expect(spawnArgs().options).toMatchObject({
    detached: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  expect(spawnArgs().fallbacks).toEqual([]);
});

it("unwraps an npm script shim without reparsing prompt argv", async () => {
  setPlatform("win32");
  const { binDir, entrypoint } = await createWindowsNpmShim({
    binDir: tempDirs.make("openclaw-child-shim-"),
    command: "gemini",
    packagePath: ["@google", "gemini-cli", "bundle", "gemini.js"],
  });
  const nodePath = path.join(binDir, "node.exe");
  await writeFile(nodePath, "", "utf8");
  const args = ["--prompt", "explain A&B | C > D and 100% coverage"];
  await setup({ argv: ["gemini", ...args], env: { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT" } });
  expect(spawnArgs().argv).toEqual([nodePath, entrypoint, ...args]);
  expect(spawnArgs().options?.windowsVerbatimArguments).toBeUndefined();
});

it("strips shell-init env from Linux OOM wrapper spawns", async () => {
  setPlatform("linux");
  const restoreShell = mockLinuxOomWrapperShell();
  vi.stubEnv("BASH_ENV", "/tmp/bashenv");
  vi.stubEnv("ENV", "/tmp/env");
  vi.stubEnv("CDPATH", "/tmp");
  try {
    await setup({ argv: ["/usr/bin/node", "-e", "process.exit(0)"] });
    expect(spawnArgs().argv).toEqual([
      "/bin/sh",
      "-c",
      'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
      "/usr/bin/node",
      "-e",
      "process.exit(0)",
    ]);
    expect(spawnArgs().options?.env).toBeDefined();
    for (const key of ["BASH_ENV", "ENV", "CDPATH"]) {
      expect(spawnArgs().options?.env?.[key]).toBeUndefined();
    }
  } finally {
    restoreShell();
  }
});

it("preserves an exact Linux env without the OOM shell wrapper", async () => {
  setPlatform("linux");
  const restoreShell = mockLinuxOomWrapperShell();
  try {
    const env = { HOME: "/worker-home", PATH: "/usr/bin", DROP_ME: undefined };
    await setup({ argv: ["/usr/bin/node", "worker"], exactEnv: true, env });
    expect(spawnArgs().argv).toEqual(["/usr/bin/node", "worker"]);
    expect(spawnArgs().options?.env).toEqual({ HOME: "/worker-home", PATH: "/usr/bin" });
  } finally {
    restoreShell();
  }
});

it("retains the cleanup deadline after out-of-order close and disposal", async () => {
  vi.useFakeTimers();
  const { adapter, emitClose } = await setup({
    onSpawnCleanup: (cleanup) => {
      void cleanup.catch((error: unknown) => {
        failure = error;
      });
    },
  });
  let failure: unknown;
  signalMock.mockImplementationOnce(() => {});
  adapter.kill("SIGKILL");
  adapter.kill("SIGKILL");
  emitClose(0);
  await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  adapter.dispose();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(failure).toEqual(
    new Error("child cleanup could not be confirmed before the kill deadline"),
  );
});

it("records tree signaling rejection in cleanup without an unhandled rejection", async () => {
  const failure = new Error("synthetic tree signaling failed");
  signalMock.mockImplementationOnce(() => {
    throw failure;
  });
  let cleanup: Promise<ProcessExtinctionResult> | undefined;
  const { adapter } = await setup({
    onSpawnCleanup: (promise) => {
      cleanup = promise;
    },
  });
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    adapter.kill("SIGKILL");
    await nextTurn();
    await nextTurn();
    expect(unhandled).not.toHaveBeenCalled();
    await expect(cleanup).rejects.toBe(failure);
  } finally {
    adapter.dispose();
    process.off("unhandledRejection", unhandled);
  }
});

it.each(["process", "stdin", "stdout", "stderr"] as const)(
  "retains startup %s errors and forwards live errors",
  async (source) => {
    const { adapter, ...stub } = await setup();
    const emitter = source === "process" ? stub.child : stub.child[source]!;
    const early = new Error("startup transport failure");
    emitter.emit("error", early);
    emitter.emit("error", new Error("duplicate startup failure"));
    const onError = vi.fn();
    adapter.onError(onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(early, source);
    const live = new Error("live transport failure");
    emitter.emit("error", live);
    expect(onError).toHaveBeenLastCalledWith(live, source);
    stub.emitExit(0);
    stub.emitClose(0);
    await adapter.wait();
    adapter.dispose();
  },
);

it("preserves startup failure when a worker error arrives during secret delivery", async () => {
  setPlatform("win32");
  const deliveryError = new Error("secret delivery failed");
  const secretStream = new Writable({
    write(_chunk, _encoding, callback) {
      child.emit("error", new Error("worker IPC failed"));
      setImmediate(() => callback(deliveryError));
    },
  });
  const { child, killMock, emitClose } = createSecretChild(secretStream);
  killMock.mockImplementation(() => {
    setImmediate(() => emitClose(null, "SIGKILL"));
    return true;
  });
  const transient = Buffer.from("synthetic-secret");

  await expect(
    start({
      argv: ["node", "worker"],
      ownedWorker: true,
      secretInput: { fd: 3, createData: () => transient },
    }),
  ).rejects.toBe(deliveryError);
  expect(killMock).toHaveBeenCalledWith("SIGKILL");
  expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
});

it.each(["darwin", "win32"] as const)(
  "withholds input and secret bytes when request authority retires during spawn on %s",
  async (platform) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const secretStream = new PassThrough();
    const secretBytes = vi.fn();
    secretStream.on("data", secretBytes);
    const { child, killMock, emitClose } = createSecretChild(secretStream);
    const startup = createDeferred<{ child: typeof child; usedFallback: boolean }>();
    const input = vi.spyOn(child.stdin!, "write");
    const createData = vi.fn(() => Buffer.from("synthetic-selected-secret"));
    spawnMock.mockReturnValueOnce(startup.promise);
    const retired = new Error("request authority retired during spawn");
    let current = true;
    const run = start({
      argv: ["agent-cli", "--prompt"],
      input: "private prompt",
      secretInput: { fd: 3, createData },
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const outcome = Promise.allSettled([run]);
    expect(spawnMock).toHaveBeenCalledOnce();
    current = false;
    startup.resolve({ child, usedFallback: false });
    try {
      await nextTurn();
      expect(killMock).toHaveBeenCalledWith("SIGKILL");
      emitClose(null, "SIGKILL");
      expect(await outcome).toEqual([{ status: "rejected", reason: retired }]);
      expect(createData).not.toHaveBeenCalled();
      expect(secretBytes).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
    } finally {
      emitClose(0);
      secretStream.destroy();
      child.removeAllListeners();
    }
  },
);

it("joins child closure after tree-first cancellation of blocked secret delivery", async () => {
  setPlatform("win32");
  signalMock.mockImplementationOnce(() => {});
  const secretStream = new Writable({
    write() {
      // Leave the secret pipe unread so construction stays blocked.
    },
  });
  const { child, killMock, emitClose } = createSecretChild(secretStream);
  const abort = new AbortController();
  const starting = start({
    argv: ["claude", "-p"],
    stdinMode: "pipe-open",
    secretInput: {
      fd: 3,
      createData: () => Buffer.from("selected-secret"),
    },
    abortSignal: abort.signal,
  });
  await nextTurn();
  const outcome = Promise.allSettled([starting]);
  const settled = vi.fn();
  void outcome.then(settled);
  abort.abort();
  await nextTurn();
  expect(signalMock).toHaveBeenCalledWith(
    child.pid,
    "SIGKILL",
    expect.objectContaining({ detached: false }),
  );
  expect(killMock).not.toHaveBeenCalled();
  signalMock.mock.calls[0]?.[2]?.onComplete?.();
  await Promise.resolve();
  expect(killMock).toHaveBeenCalledWith("SIGKILL");
  expect(settled).not.toHaveBeenCalled();

  emitClose(null, "SIGKILL");
  await expect(starting).rejects.toMatchObject({ message: "secret delivery aborted" });
});
