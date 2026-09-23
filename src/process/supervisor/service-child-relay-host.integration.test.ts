import { Duplex, PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { createStubChild, firstMockArg } from "./adapters/child.test-support.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import { createProcessSupervisor } from "./supervisor.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
let platformMock: ReturnType<typeof mockProcessPlatform> | undefined;
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  await nextTurn();
  platformMock?.mockRestore();
  platformMock = undefined;
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function createWritableRelayChild() {
  const stub = createStubChild();
  const control = new Duplex({
    autoDestroy: false,
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const lineage = new PassThrough();
  Object.defineProperty(stub.child, "stdio", {
    value: [stub.child.stdin, stub.child.stdout, stub.child.stderr, control, lineage],
    configurable: true,
  });
  mocks.spawn.mockReturnValue(stub.child);
  return { ...stub, control, lineage };
}

// This path exercises the real supervisor -> child -> relay bridge. Only the
// OS child and group-absence probe are controlled by the fixture.
async function startSupervisedRelay(
  options: { timeoutMs?: number; noOutputTimeoutMs?: number } = {},
) {
  platformMock = mockProcessPlatform("linux");
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("fixture group absent"), { code: "ESRCH" });
  });
  const stub = createWritableRelayChild();
  const supervisor = createProcessSupervisor();
  const closeScope = supervisor.acquireScopeCleanup("relay-output", {
    processTree: "required-all",
  });
  const starting = supervisor.spawn({
    mode: "anchored-shell",
    command: "synthetic-command",
    scopeKey: "relay-output",
    ...options,
  });
  // Scope admission is asynchronous; this is not a readiness delay in the product.
  await nextTurn();
  const start = firstMockArg(stub.sendMock, "supervised service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("missing generation");
  }
  const generation = start.generation;
  let sequence = 0;
  const emit = (payload: ServiceChildAnchorPayload) =>
    stub.control.push(
      Buffer.from(encodeServiceChildMessage({ ...payload, generation, sequence: ++sequence })),
    );
  const finish = () => {
    emit({ type: "closing", reason: "lineage-closed" });
    stub.lineage.end();
    stub.control.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
  };
  cleanups.push(() => {
    stub.control.destroy();
    stub.lineage.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
  });
  return { ...stub, supervisor, closeScope, starting, emit, finish };
}

it.each(["stdout", "stderr"] as const)(
  "retains %s construction errors through the actual caller",
  async (stream) => {
    const f = await startSupervisedRelay();
    const cause = new Error("raw construction failure");
    f.child[stream]?.emit("error", cause);
    f.emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const run = await f.starting;
    const rejected = expect(run.wait()).rejects.toBe(cause);
    f.emit({ type: "root-result", code: 0, signal: null });
    f.child.stdout?.emit("end");
    f.child.stderr?.emit("end");
    f.finish();
    await rejected;
    await expect(run.waitForExtinction?.()).rejects.toBe(cause);
    await expect(f.closeScope()).rejects.toBe(cause);
  },
);

it.each(["stdout", "stderr"] as const)(
  "rejects premature %s close after root exit through the actual caller",
  async (stream) => {
    const f = await startSupervisedRelay();
    f.emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const run = await f.starting;
    const rejected = expect(run.wait()).rejects.toThrow("closed before EOF");
    f.emit({ type: "root-result", code: 0, signal: null });
    f.child[stream]?.emit("close");
    f.child[stream === "stdout" ? "stderr" : "stdout"]?.emit("end");
    f.finish();
    await rejected;
    await expect(f.closeScope()).rejects.toThrow("closed before EOF");
  },
);

it("retains a late raw error during cleanup without rewriting the terminal result", async () => {
  const f = await startSupervisedRelay();
  f.emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
  const run = await f.starting;
  f.child.stdout?.emit("data", Buffer.from("final tail"));
  f.emit({ type: "root-result", code: 0, signal: null });
  f.child.stdout?.emit("end");
  f.child.stderr?.emit("end");
  const terminal = await run.wait();
  expect(terminal.stdout).toBe("final tail");
  const cause = new Error("raw failure during pending extinction");
  f.child.stderr?.emit("error", cause);
  f.finish();
  await expect(run.waitForExtinction?.()).rejects.toBe(cause);
  await expect(f.closeScope()).rejects.toBe(cause);
  expect(await run.wait()).toBe(terminal);
});

it("joins native cleanup with final output before reporting no-loss settlement", async () => {
  const f = await startSupervisedRelay();
  f.emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
  const run = await f.starting;
  const settled = vi.fn();
  const cleanup = run.waitForExtinction?.();
  void cleanup?.then(settled, settled);
  f.emit({ type: "root-result", code: 0, signal: null });
  f.finish();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  f.child.stdout?.emit("data", Buffer.from("late final tail"));
  f.child.stdout?.emit("end");
  f.child.stderr?.emit("end");
  expect((await run.wait()).stdout).toBe("late final tail");
  await cleanup;
  await expect(f.closeScope()).resolves.toBeUndefined();
});

it.each(["cancel", "overall-timeout"] as const)(
  "preserves output and original %s during relay construction",
  async (mode) => {
    const f = await startSupervisedRelay({ timeoutMs: mode === "overall-timeout" ? 50 : 1000 });
    const sending = f.sendMock.mock.calls.length;
    f.child.stdout?.emit("data", Buffer.from("before cancellation"));
    if (mode === "cancel") {
      f.supervisor.cancelScope("relay-output");
    }
    const run = await f.starting;
    expect((await run.wait()).reason).toBe(mode === "cancel" ? "manual-cancel" : mode);
    expect((await run.wait()).stdout).toBe("before cancellation");
    expect(f.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(f.sendMock.mock.calls.length).toBe(sending);
    await expect(f.closeScope()).rejects.toThrow("construction aborted");
  },
);

it("counts raw-only construction activity without renewing the original overall deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const f = await startSupervisedRelay({ timeoutMs: 100, noOutputTimeoutMs: 60 });
    await vi.advanceTimersByTimeAsync(40);
    f.child.stdout?.emit("data", Buffer.from([0xe2]));
    await vi.advanceTimersByTimeAsync(40);
    f.child.stdout?.emit("data", Buffer.from([0x82]));
    expect(f.killMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    const run = await f.starting;
    expect((await run.wait()).reason).toBe("overall-timeout");
    await expect(f.closeScope()).rejects.toThrow("construction aborted");
  } finally {
    vi.useRealTimers();
  }
});

it.each(["cancel", "deadline", "shutdown"] as const)(
  "reports native cleanup failure without waiting for output during %s",
  async (action) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const f = await startSupervisedRelay({ timeoutMs: 10 });
    f.emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const run = await f.starting;
    f.child.stdout?.emit("data", Buffer.from("retained root output"));
    f.emit({ type: "root-result", code: 23, signal: null });
    // No closing receipt, and stdout/stderr intentionally never reach EOF until finally.
    f.control.destroy();
    f.lineage.end();
    f.disconnectMock();
    f.emitExit(0);
    await nextTurn();
    let observed: unknown;
    const observeFailure = (error: unknown) => {
      observed = error;
    };
    if (!run.waitForExtinction) {
      throw new Error("missing native cleanup owner");
    }
    const cleanup =
      action === "shutdown"
        ? f.supervisor.shutdown()
        : action === "cancel"
          ? f.closeScope()
          : run.waitForExtinction();
    void cleanup.catch(observeFailure);
    try {
      if (action === "deadline") {
        await vi.advanceTimersByTimeAsync(10);
      }
      await nextTurn();
      expect(observed).toBeInstanceOf(Error);
      expect(String(observed)).toContain("cleanup identity lost");
      await expect(run.waitForExtinction?.()).rejects.toBe(observed);
    } finally {
      f.child.stdout?.emit("end");
      f.child.stderr?.emit("end");
      const result = await run.wait();
      expect(result.stdout).toBe("retained root output");
      expect(result.exitCode).toBe(23);
      await cleanup.catch(() => undefined);
      await f.closeScope().catch(() => undefined);
      vi.useRealTimers();
    }
  },
);
