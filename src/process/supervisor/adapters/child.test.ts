import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { closeOwnedStdioProcess } from "../../owned-stdio.js";
import type { ProcessExtinctionResult } from "../types.js";
import {
  createStubChild,
  createWindowsNpmShim,
  firstSpawnAndWaitParams,
  readyChildAdapter,
  setPlatform,
} from "./child.test-support.js";
import {
  expectWaitStaysPendingUntilSigkillFallback,
  mockLinuxOomWrapperShell,
} from "./test-support.js";

const { spawnMock, signalMock, decoderMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  signalMock: vi.fn<typeof import("../../kill-tree.js").signalProcessTree>(),
  decoderMock:
    vi.fn<typeof import("../../../infra/windows-encoding.js").createWindowsOutputDecoder>(),
}));
vi.mock("../../spawn-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../spawn-utils.js")>()),
  spawnAndWait: spawnMock,
}));
vi.mock("../../kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../kill-tree.js")>()),
  signalProcessTree: signalMock,
}));
vi.mock("../../../infra/windows-encoding.js", () => ({ createWindowsOutputDecoder: decoderMock }));
// mock-isolation: Child-adapter tests own process fixtures and must not initialize the service relay.
vi.mock("../service-child-relay-host.js", () => ({ createServiceChildRelayAdapter: vi.fn() }));

let start: ReturnType<typeof readyChildAdapter>;
let roots: typeof import("../../../infra/windows-install-roots.js").getWindowsInstallRoots;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const decode = (chunk: Buffer | string) =>
  Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
type Input = Partial<
  Omit<Parameters<typeof start>[0], "anchoredShellCommand" | "stdoutConsumption">
>;
function createSecretChild(secret: Writable, value = "selected-secret") {
  const child = createStubChild();
  const transient = Buffer.from(value);
  Object.defineProperty(child.child, "stdio", {
    value: [child.child.stdin, child.child.stdout, child.child.stderr, secret],
    configurable: true,
  });
  spawnMock.mockResolvedValue(child.child);
  return {
    ...child,
    transient,
    startSecret: (input: Input = {}) =>
      start({
        argv: ["node", "worker"],
        secretInput: { fd: 3, createData: () => transient },
        ...input,
      }),
  };
}
async function setup(input: Input = {}) {
  const { argv = ["node", "worker"], ...options } = input;
  const stub = createStubChild();
  spawnMock.mockResolvedValue(stub.child);
  const adapter = await start({ argv, stdinMode: "pipe-open", ...options });
  return { ...stub, adapter };
}
function setupTimed(platform = process.platform, input: Input = {}) {
  vi.useFakeTimers();
  setPlatform(platform);
  return setup(input);
}

const spawnArgs = () => firstSpawnAndWaitParams(spawnMock);
function watch(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  return settled;
}
async function advancePending(settled: ReturnType<typeof watch>, ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(settled).not.toHaveBeenCalled();
}
function observeOutput(adapter: Awaited<ReturnType<typeof start>>) {
  const stdout = vi.fn(),
    stderr = vi.fn();
  adapter.onStdout(stdout);
  adapter.onStderr(stderr);
  return { stdout, stderr };
}

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
  decoderMock.mockReset().mockImplementation(() => ({ decode, flush: () => "" }));
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
});

it("creates owned worker groups and gates startup through IPC", async () => {
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "service-managed");
  const { adapter, sendMock, disconnectMock } = await setup({ ownedWorker: true, input: "{}" });
  expect(spawnArgs().options?.detached).toBe(process.platform !== "win32");
  expect(spawnArgs().options?.stdio).toEqual(["pipe", "pipe", "pipe", "ipc"]);
  await adapter.openStartGate?.();
  expect(sendMock).toHaveBeenCalledWith({ type: "openclaw-worker-start-v1" }, expect.any(Function));
  adapter.closeStartGate?.();
  expect(disconnectMock).toHaveBeenCalledOnce();
});

it("joins worker exit, closed pipes and the queued IPC disconnect", async () => {
  const { adapter, child, disconnectMock, emitExit } = await setupTimed("darwin", {
    ownedWorker: true,
  });
  disconnectMock.mockImplementation(() => {
    Object.defineProperty(child, "connected", { value: false });
  });
  const settled = watch(adapter.wait());
  adapter.closeStartGate?.();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.emit("end");
    await advancePending(settled);
    stream?.emit("close");
  }
  emitExit(7);
  await advancePending(settled);
  child.emit("disconnect");
  await expect(adapter.wait()).resolves.toEqual({ code: 7, signal: null });
  expect(signalMock).not.toHaveBeenCalled();
  adapter.dispose();
});

it("keeps ordinary children supervised through repeated operational errors", async () => {
  const { adapter, child, emitExit, emitClose } = await setup();
  const errors = vi.fn();
  adapter.onError(errors);
  const errorListenerCount = child.listenerCount("error");
  const settled = watch(adapter.wait());
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
    child.emit("error", error);
    expect(errors).toHaveBeenNthCalledWith(attempt + 1, error, "process");
    expect(child.listenerCount("error")).toBe(errorListenerCount);
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
  for (const event of ["error", "exit", "close"]) {
    expect(child.listenerCount(event)).toBe(0);
  }
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

it("captures close while secret delivery is still pending", async () => {
  setPlatform("win32");
  let delivered = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      delivered = chunk.toString();
      child.emitClose(0);
      setImmediate(callback);
    },
  });
  const child = createSecretChild(stream);
  const adapter = await child.startSecret({ argv: ["claude", "-p"] });
  await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  expect(delivered).toBe("selected-secret");
  expect(child.transient.equals(Buffer.alloc(child.transient.length))).toBe(true);
});

it("rejects writes after stdin ends and tracks destruction", async () => {
  const { adapter } = await setup();
  expect(adapter.stdin).toMatchObject({ writable: true, writableEnded: false });
  adapter.stdin?.end();
  expect(adapter.stdin).toMatchObject({ writable: false, writableEnded: true });
  const callback = vi.fn();
  adapter.stdin?.write("late", callback);
  expect(callback).toHaveBeenCalledWith(expect.any(Error));
  adapter.stdin?.destroy?.();
  expect(adapter.stdin?.destroyed).toBe(true);
});

it("detaches only decoder-owned listeners after the kill fallback", async () => {
  const flush = vi.fn(() => "flushed tail");
  decoderMock.mockImplementation(() => ({ decode: (chunk) => `decoded:${decode(chunk)}`, flush }));
  const { adapter, child } = await setupTimed();
  const stdoutClose = vi.fn(),
    stderrClose = vi.fn();
  child.stdout?.on("close", stdoutClose);
  child.stderr?.on("close", stderrClose);
  const { stdout, stderr } = observeOutput(adapter);
  child.stdout?.emit("data", Buffer.from("drained stdout"));
  child.stderr?.emit("data", Buffer.from("drained stderr"));
  expect(stdout).toHaveBeenCalledExactlyOnceWith("decoded:drained stdout");
  expect(stderr).toHaveBeenCalledExactlyOnceWith("decoded:drained stderr");
  await expectWaitStaysPendingUntilSigkillFallback(adapter.wait(), () => adapter.kill());
  const error = new Error("queued output error");
  child.stderr!.destroy(error);
  adapter.dispose();
  expect(child.stdout).toMatchObject({ destroyed: true });
  expect(child.stderr).toMatchObject({ destroyed: true });
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
  signalMock.mockImplementationOnce(() => {}).mockImplementationOnce(() => {});
  const { adapter } = await setupTimed("win32");
  const settled = watch(adapter.wait());
  const rejected = expect(closeOwnedStdioProcess(adapter, { force: true })).rejects.toThrow(
    "before the kill deadline",
  );
  await vi.advanceTimersByTimeAsync(3_000);
  adapter.kill("SIGKILL");
  await advancePending(settled, 999);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledExactlyOnceWith({ code: null, signal: "SIGKILL" });
  await rejected;
  adapter.kill("SIGKILL");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(settled).toHaveBeenCalledOnce();
  await expect(adapter.waitForExtinction!()).rejects.toThrow("before the kill deadline");
  adapter.dispose();
});

it.each(["open", "closed"] as const)(
  "joins Windows tree kill before settling %s streams",
  async (streams) => {
    let complete: (() => void) | undefined;
    signalMock.mockImplementationOnce((_pid, _signal, options) => {
      complete = options?.onComplete;
    });
    const { adapter, child, emitExit, emitClose } = await setupTimed("win32", {
      stdinMode: "pipe-closed",
    });
    const settled = watch(adapter.wait());
    adapter.kill("SIGKILL");
    adapter.closeStartGate?.();
    emitExit(null, "SIGKILL");
    if (streams === "closed") {
      emitClose(null, "SIGKILL");
    }
    await advancePending(settled, 1_000);
    expect(child.stdout?.destroyed).toBe(false);
    expect(child.stderr?.destroyed).toBe(false);
    complete?.();
    await vi.advanceTimersByTimeAsync(0);
    if (streams === "open") {
      await advancePending(settled, 249);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.stdout?.destroyed).toBe(true);
      expect(child.stderr?.destroyed).toBe(true);
    }
    expect(settled).toHaveBeenCalledWith({ code: null, signal: "SIGKILL" });
  },
);

it("preserves descendant output after ordinary Windows exit", async () => {
  const { adapter, emitExit, child } = await setupTimed("win32", { stdinMode: "pipe-closed" });
  const { stdout, stderr } = observeOutput(adapter);
  const settled = watch(adapter.wait());
  emitExit(0);
  await advancePending(settled, 1_000);
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
});

it("unwraps an npm script shim without reparsing prompt argv", async () => {
  setPlatform("win32");
  const { binDir, entrypoint } = await createWindowsNpmShim({
    binDir: tempDirs.make("openclaw-child-shim-"),
    command: "gemini",
    packagePath: ["@google", "gemini-cli", "bundle", "gemini.js"],
  });
  const nodePath = path.join(binDir, "node.EXE");
  await writeFile(nodePath, "", "utf8");
  const args = ["--prompt", "explain A&B | C > D and 100% coverage"];
  await setup({ argv: ["gemini", ...args], env: { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT" } });
  expect(spawnArgs().argv).toEqual([nodePath, entrypoint, ...args]);
  expect(spawnArgs().options?.windowsVerbatimArguments).toBeUndefined();
});

it.each([false, true])("handles Linux spawn environment (exact=%s)", async (exact) => {
  setPlatform("linux");
  using shell = { [Symbol.dispose]: mockLinuxOomWrapperShell() };
  void shell;
  const shellEnv = { BASH_ENV: "/tmp/bashenv", ENV: "/tmp/env", CDPATH: "/tmp" };
  for (const [key, value] of Object.entries(shellEnv)) {
    vi.stubEnv(key, value);
  }
  const argv = ["/usr/bin/node", "worker"];
  const env = { HOME: "/worker-home", PATH: "/usr/bin", DROP_ME: undefined };
  await setup({ argv, exactEnv: exact ? true : undefined, env: exact ? env : undefined });
  expect(spawnArgs().argv).toEqual(
    exact
      ? argv
      : [
          "/bin/sh",
          "-c",
          'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
          ...argv,
        ],
  );
  if (exact) {
    expect(spawnArgs().options?.env).toEqual({ HOME: "/worker-home", PATH: "/usr/bin" });
  } else {
    expect(spawnArgs().options?.env).toBeDefined();
    for (const key of Object.keys(shellEnv)) {
      expect(spawnArgs().options?.env?.[key]).toBeUndefined();
    }
  }
});

it("retains the cleanup deadline after out-of-order close and disposal", async () => {
  const { adapter, emitClose } = await setupTimed(process.platform, {
    onSpawnCleanup: (cleanup) => void cleanup.catch((error: unknown) => (failure = error)),
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

it.each(["process", "stdin", "stdout"] as const)(
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
  const { child, killMock, emitClose, transient, startSecret } = createSecretChild(
    secretStream,
    "synthetic-secret",
  );
  killMock.mockImplementation(() => {
    setImmediate(() => emitClose(null, "SIGKILL"));
    return true;
  });
  await expect(startSecret({ ownedWorker: true })).rejects.toBe(deliveryError);
  expect(killMock).toHaveBeenCalledWith("SIGKILL");
  expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
});

it("withholds input and secret bytes when request authority retires during spawn", async () => {
  setPlatform("darwin");
  const secretStream = new PassThrough();
  const secretBytes = vi.fn();
  secretStream.on("data", secretBytes);
  const { child, killMock, emitClose } = createSecretChild(secretStream);
  const startup = createDeferred<typeof child>();
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
  startup.resolve(child);
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
});

it("joins child closure after tree-first cancellation of blocked secret delivery", async () => {
  setPlatform("win32");
  signalMock.mockImplementationOnce(() => {});
  const secretStream = new Writable({
    write() {
      // Leave the secret pipe unread so construction stays blocked.
    },
  });
  const { child, killMock, emitClose, startSecret } = createSecretChild(secretStream);
  const abort = new AbortController();
  const starting = startSecret({
    argv: ["claude", "-p"],
    stdinMode: "pipe-open",
    abortSignal: abort.signal,
  });
  await nextTurn();
  const outcome = Promise.allSettled([starting]);
  const settled = watch(outcome);
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
