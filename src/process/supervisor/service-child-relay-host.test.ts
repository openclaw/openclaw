import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { closeOwnedStdioProcess } from "../owned-stdio.js";
import * as childAdapter from "./adapters/child.js";
import { firstMockArg } from "./adapters/child.test-support.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import { runWithProcessCleanupBudget } from "./cleanup-budget.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import {
  createRelayFixture,
  createServiceChildRelayAdapter,
  createWritableRelayChild,
} from "./service-child-relay-host.test-support.js";
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
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  await nextTurn();
  platformMock?.mockRestore();
  platformMock = undefined;
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

// These fixtures model POSIX process-group receipts, not Linux subreaper certificates.
async function createRelay(platform: "darwin" | "win32", retainLineage = false) {
  platformMock = mockProcessPlatform(platform);
  return createRelayFixture(
    platform,
    retainLineage,
    (child) => mocks.spawn.mockReturnValue(child),
    (cleanup) => cleanups.push(cleanup),
  );
}

it.each(["before", "after"] as const)(
  "checks launch policy %s relay start dispatch",
  async (timing) => {
    platformMock = mockProcessPlatform("darwin");
    const stub = createWritableRelayChild();
    mocks.spawn.mockReturnValue(stub.child);
    let allowed = true;
    mocks.spawn.mockImplementation(() => {
      if (timing === "before") {
        allowed = false;
      }
      return stub.child;
    });
    const starting = createServiceChildRelayAdapter({
      command: "synthetic-command",
      args: [],
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
      beforeSpawn: () => {
        if (!allowed) {
          throw new Error("relay launch policy revoked");
        }
      },
    });
    try {
      if (timing === "before") {
        await expect(starting).rejects.toThrow("relay launch policy revoked");
        expect(stub.sendMock.mock.calls.length).toBe(0);
      } else {
        const start = firstMockArg(stub.sendMock, "service start");
        if (!isRecord(start) || typeof start.generation !== "string") {
          throw new Error("Expected an admitted service generation");
        }
        const generation = start.generation;
        allowed = false;
        const emit = (payload: ServiceChildAnchorPayload, sequence: number) => {
          stub.control.push(
            Buffer.from(encodeServiceChildMessage({ ...payload, generation, sequence })),
          );
        };
        emit({ type: "ready", commandPid: 1234, anchorPid: 1235 }, 1);
        const adapter = await starting;
        emit({ type: "root-result", code: 0, signal: null }, 2);
        stub.child.stdout?.emit("end");
        stub.child.stderr?.emit("end");
        expect((await adapter.wait()).code).toBe(0);
        expect(stub.killMock.mock.calls.length).toBe(0);
      }
    } finally {
      stub.control.destroy();
      stub.disconnectMock();
      stub.emitExit(0);
    }
  },
);

it.each(["current", "revoked"] as const)(
  "checks %s authority after remote preparation and retains custody until native readiness",
  async (authority) => {
    platformMock = mockProcessPlatform("darwin");
    const stub = createWritableRelayChild();
    mocks.spawn.mockReturnValue(stub.child);
    const writes = vi.spyOn(stub.control, "write");
    const grantReached = createDeferredCore();
    let current = true;
    let released = false;
    const starting = createServiceChildRelayAdapter({
      command: "synthetic-command",
      args: [],
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
      initiateSpawn(launch, settlement) {
        grantReached.resolve();
        if (!current) {
          throw new Error("launch revoked");
        }
        void settlement?.then(() => {
          released = true;
        });
        return launch();
      },
    });
    const start = firstMockArg(stub.sendMock, "remote preparation");
    if (!isRecord(start) || typeof start.generation !== "string") {
      throw new Error("Expected remote preparation identity");
    }
    const generation = start.generation;
    const emit = (payload: ServiceChildAnchorPayload, sequence: number) =>
      stub.control.push(
        Buffer.from(encodeServiceChildMessage({ ...payload, generation, sequence })),
      );
    const rejected =
      authority === "current" ? undefined : expect(starting).rejects.toThrow("launch revoked");
    current = authority !== "revoked";
    emit({ type: "prepared" }, 1);
    await grantReached.promise;
    expect(released).toBe(false);
    try {
      if (rejected) {
        await rejected;
        expect(writes.mock.calls.some(([chunk]) => String(chunk).includes('"type":"launch"'))).toBe(
          false,
        );
      } else {
        expect(writes.mock.calls.some(([chunk]) => String(chunk).includes('"type":"launch"'))).toBe(
          true,
        );
        emit({ type: "ready", commandPid: 1234, anchorPid: 1235 }, 2);
        const adapter = await starting;
        expect(released).toBe(true);
        emit({ type: "root-result", code: 0, signal: null }, 3);
        stub.stdout.emit("end");
        stub.stderr.emit("end");
        await adapter.wait();
      }
    } finally {
      stub.control.destroy();
      stub.lineage.destroy();
      stub.disconnectMock();
      stub.emitExit(0);
    }
  },
);

it("reports cleanup uncertainty when deferred start delivery fails after abort", async () => {
  platformMock = mockProcessPlatform("darwin");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  const startCallbacks: Array<(error: Error | null) => void> = [];
  stub.sendMock.mockImplementation((_message, ...args) => {
    const callback = args.findLast(
      (value): value is (error: Error | null) => void => typeof value === "function",
    );
    if (!callback) {
      throw new Error("Expected a start delivery callback");
    }
    startCallbacks.push(callback);
    return true;
  });
  const abort = new AbortController();
  const starting = createServiceChildRelayAdapter({
    command: "synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
    abortSignal: abort.signal,
  });
  await nextTurn();
  expect(stub.killMock).not.toHaveBeenCalled();
  expect(startCallbacks).toHaveLength(1);

  abort.abort();
  const rejected = expect(starting).rejects.toThrow("service child cleanup identity lost");
  startCallbacks[0]!(new Error("synthetic start delivery failed"));
  await rejected;
  expect(stub.killMock).toHaveBeenCalledWith("SIGKILL");
  await nextTurn();
  stub.control.destroy();
  stub.emitExit(null, "SIGKILL");
});

it("keeps rejected Windows construction ownership failures visible to supervisor joins", async () => {
  platformMock = mockProcessPlatform("win32");
  const stub = createWritableRelayChild();
  mocks.spawn.mockReturnValue(stub.child);
  const supervisor = createProcessSupervisor();
  const scopeKey = "scope:rejected-construction";
  const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  const pending = supervisor.spawn({
    runId: "rejected-construction",
    mode: "anchored-shell",
    command: "synthetic-command",
    scopeKey,
  });
  await nextTurn();
  supervisor.cancel("rejected-construction");
  const run = await pending;
  await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
  const outcomes = Promise.allSettled([cleanupScope(), supervisor.shutdown()]);
  stub.control.destroy();
  stub.disconnectMock();
  stub.emitExit(null, "SIGKILL");

  for (const outcome of await outcomes) {
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("service child cleanup identity lost"),
      }),
    });
  }
  await expect(cleanupScope()).rejects.toThrow("cleanup identity lost");
  await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
});

it("refreshes the supervisor deadline from text-only Windows Job output", async () => {
  const { adapter, emit, completeRoot, close } = await createRelay("win32");
  vi.spyOn(childAdapter, "createChildAdapter").mockResolvedValue({
    adapter,
    ready: Promise.resolve(),
  });
  const nowSpy = vi.spyOn(performance, "now").mockReturnValue(10_000);
  const supervisor = createProcessSupervisor();
  const run = await supervisor.spawn({
    mode: "anchored-shell",
    command: "synthetic-command",
    noOutputTimeoutMs: 1_000,
  });
  try {
    nowSpy.mockReturnValue(10_800);
    emit({ type: "output", stream: "stdout", chunk: "still running" });
    nowSpy.mockReturnValue(11_600);
    completeRoot();
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      noOutputTimedOut: false,
      stdout: "still running",
    });
  } finally {
    completeRoot();
    emit({ type: "closing", reason: "lineage-closed" });
    close();
    await run.wait();
    await run.waitForExtinction!();
    await supervisor.shutdown();
  }
});

it.each(["fragmented", "completed"] as const)(
  "caps a %s control line before decoding or unbounded search",
  async (form) => {
    const { adapter, floodControl, controlEncoding, killSpy, close } = await createRelay("darwin");
    const parseSpy = vi.spyOn(JSON, "parse");
    expect(controlEncoding()).toBeNull();
    const rejectedWait = expect(adapter.wait()).rejects.toThrow(
      "control pipe pending line exceeded cap",
    );
    const rejectedExtinction = expect(adapter.waitForExtinction()).rejects.toThrow(
      "control pipe pending line exceeded cap",
    );
    const chunk = "é".repeat(32 * 1024);
    const frame = Buffer.from(`${chunk.repeat(4)}é\n`);
    const fullFrameSearch = vi.spyOn(frame, "indexOf");
    if (form === "fragmented") {
      for (let index = 0; index < 4; index += 1) {
        floodControl(chunk);
      }
      expect(killSpy).not.toHaveBeenCalled();
      floodControl("é");
    } else {
      floodControl(frame);
    }
    await rejectedWait;
    await rejectedExtinction;
    expect(parseSpy).not.toHaveBeenCalled();
    if (form === "completed") {
      expect(fullFrameSearch).not.toHaveBeenCalled();
    }
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
    close();
  },
);

it("publishes root exit before drain, replays it, and acknowledges only the closing receipt", async () => {
  const { adapter, start, acknowledgements, emit, completeRoot, close } =
    await createRelay("darwin");
  expect(start.acknowledgeClosing).toBe(true);
  const onExit = vi.fn();
  adapter.onExit(onExit);
  emit({ type: "root-result", code: 0, signal: null });
  await nextTurn();
  expect(onExit).toHaveBeenCalledExactlyOnceWith(0, null);
  const lateExit = vi.fn();
  adapter.onExit(lateExit);
  expect(lateExit).toHaveBeenCalledExactlyOnceWith(0, null);
  completeRoot();
  await adapter.wait();
  const closing = emit({ type: "closing", reason: "lineage-closed" });
  const settled = vi.fn();
  const extinction = adapter.waitForExtinction();
  void extinction.then(settled, settled);
  await nextTurn();
  expect(acknowledgements).toEqual([
    {
      type: "closing-ack",
      generation: closing.generation,
      sequence: 1,
      closingSequence: closing.sequence,
    },
  ]);
  expect(settled).not.toHaveBeenCalled();
  close();
  await expect(extinction).resolves.toBeUndefined();
});

it("keeps an observed Windows root result independent of failed extinction", async () => {
  const { adapter, emit, endOutput, close } = await createRelay("win32");
  adapter.kill("SIGTERM");
  emit({ type: "root-result", code: 23, signal: null });
  await nextTurn();
  const root = adapter.wait();
  const settled = vi.fn();
  void root.then(settled, settled);
  close();
  await expect(adapter.waitForExtinction()).rejects.toThrow("cleanup identity lost");
  expect(settled).not.toHaveBeenCalled();
  endOutput();
  await expect(root).resolves.toEqual({ code: 23, signal: null });
});

it.each(["darwin", "win32"] as const)(
  "preserves confirmed extinction when an earlier cancellation fails after the receipt (%s)",
  async (platform) => {
    const { adapter, cancellations, emit, completeRoot, close } = await createRelay(platform);
    completeRoot();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    const extinction = adapter.waitForExtinction();
    const settled = vi.fn();
    void extinction.then(settled, settled);
    adapter.kill();
    expect(cancellations).toHaveLength(1);
    emit({ type: "closing", reason: "lineage-closed" });
    cancellations[0]!(new Error("synthetic closed control channel"));
    await nextTurn();
    expect(settled).not.toHaveBeenCalled();
    close();
    await expect(extinction).resolves.toBeUndefined();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  },
);

it("rejects failed cancellation without an authoritative closing receipt", async () => {
  const { adapter, cancellations, completeRoot } = await createRelay("darwin");
  const onError = vi.fn();
  adapter.onError(onError);
  completeRoot();
  const rejected = expect(adapter.waitForExtinction()).rejects.toThrow(
    "service child cleanup identity lost",
  );
  adapter.kill();
  cancellations[0]!(new Error("synthetic closed control channel"));
  await rejected;
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("cleanup identity lost") }),
    "process",
  );
});

it.each(["EOF", "close"])("joins outside-group lineage with %s", async (ending) => {
  const { adapter, completeRoot, emit, close, lineage } = await createRelay("darwin", true);
  completeRoot();
  await adapter.wait();
  emit({ type: "closing", reason: "cancel" });
  await nextTurn();
  const extinction = adapter.waitForExtinction();
  const settled = vi.fn();
  void extinction.then(settled, settled);
  close();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  if (ending === "EOF") {
    lineage.end();
    await expect(extinction).resolves.toBeUndefined();
  } else {
    lineage.destroy();
    await expect(extinction).rejects.toThrow("cleanup identity lost");
  }
});

it("waits for relay reaping before confirming extinction", async () => {
  const { adapter, completeRoot, emit, closeControl, exitRelay, groupProbe, lineage } =
    await createRelay("darwin");
  vi.spyOn(performance, "now").mockReturnValue(10_000);
  groupProbe.mockImplementation(() => {
    throw Object.assign(new Error("synthetic unreaped anchor group"), { code: "EPERM" });
  });
  completeRoot();
  await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  lineage.end();
  await nextTurn();
  emit({ type: "closing", reason: "lineage-closed" });
  await nextTurn();
  const settled = vi.fn();
  const extinction = adapter.waitForExtinction();
  void extinction.then(settled, settled);
  closeControl();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  expect(groupProbe).not.toHaveBeenCalled();
  groupProbe.mockImplementation(() => {
    throw Object.assign(new Error("synthetic reaped anchor group"), { code: "ESRCH" });
  });
  exitRelay();
  await expect(extinction).resolves.toBeUndefined();
  expect(groupProbe).toHaveBeenCalledExactlyOnceWith(-1235, 0);
});

it.each(["before", "after"])(
  "joins a closing relay beyond cancellation grace when shutdown starts %s its receipt",
  async (order) => {
    const { adapter, completeRoot, emit, closeControl, exitRelay, lineage } =
      await createRelay("darwin");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const warn = vi.fn();
    const settled = vi.fn();
    const extinction = adapter.waitForExtinction();
    void extinction.then(settled, settled);
    if (order === "before") {
      runWithProcessCleanupBudget({ deadline: 20_000, warn }, () => adapter.kill("SIGTERM"));
    }
    completeRoot();
    emit({ type: "closing", reason: "cancel" });
    lineage.end();
    await nextTurn();
    closeControl();
    await nextTurn();
    if (order === "after") {
      now.mockReturnValue(11_000);
      await vi.advanceTimersByTimeAsync(1_000);
      runWithProcessCleanupBudget({ deadline: 20_000, warn }, () => adapter.kill("SIGTERM"));
    }
    now.mockReturnValue(16_000);
    await vi.advanceTimersByTimeAsync(order === "before" ? 6_000 : 5_000);
    expect(settled).not.toHaveBeenCalled();
    exitRelay();
    await expect(extinction).resolves.toBeUndefined();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "service child relay required forced retirement; cleanup completed",
    );
  },
);

it("escalates a stuck relay and retains failure within a shorter shutdown deadline", async () => {
  const { adapter, completeRoot, emit, closeControl, lineage, killSpy } =
    await createRelay("darwin");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
  const warn = vi.fn();
  const outcomes = Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]);
  runWithProcessCleanupBudget({ deadline: 12_000, warn }, () => adapter.kill("SIGTERM"));
  completeRoot();
  emit({ type: "closing", reason: "cancel" });
  lineage.end();
  await nextTurn();
  closeControl();
  await nextTurn();
  now.mockReturnValue(11_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(killSpy).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  runWithProcessCleanupBudget({ deadline: 30_000, warn }, () => adapter.kill("SIGKILL"));
  now.mockReturnValue(12_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(warn).not.toHaveBeenCalled();
});

it("retires a queued ordinary expiry when shutdown adopts the pending cleanup", async () => {
  const { adapter, completeRoot, emit, closeControl, exitRelay, lineage } =
    await createRelay("darwin");
  const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"] });
  const settled = vi.fn();
  const extinction = adapter.waitForExtinction();
  void extinction.then(settled, settled);
  completeRoot();
  emit({ type: "closing", reason: "cancel" });
  lineage.end();
  await vi.advanceTimersByTimeAsync(0);
  closeControl();
  await vi.advanceTimersByTimeAsync(0);
  now.mockReturnValue(15_000);
  vi.advanceTimersByTime(5_000);
  runWithProcessCleanupBudget({ deadline: 20_000, warn: vi.fn() }, () => adapter.kill("SIGTERM"));
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).not.toHaveBeenCalled();
  exitRelay();
  await expect(extinction).resolves.toBeUndefined();
});

it.each(["EPERM", "EIO"])(
  "keeps graceful cleanup uncertain when the kernel group is %s",
  async (failure) => {
    const { adapter, completeRoot, emit, close, groupProbe, lineage } = await createRelay("darwin");
    const cause = Object.assign(new Error(`synthetic ${failure}`), { code: failure });
    groupProbe.mockImplementation(() => {
      throw cause;
    });
    completeRoot();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    lineage.end();
    await nextTurn();
    // Exhaust the monotonic observation window without waiting on real process time.
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    now.mockReturnValue(15_000);
    close();
    await expect(adapter.waitForExtinction()).rejects.toThrow(
      failure === "EIO" ? "owned process group" : "hard deadline",
    );
    if (failure === "EIO") {
      await expect(adapter.waitForExtinction()).rejects.toSatisfy(
        (error: unknown) => error instanceof Error && error.cause === cause,
      );
    } else {
      await expect(adapter.waitForExtinction()).rejects.toMatchObject({
        cause: { durationMs: GRACEFUL_CANCEL_TIMEOUT_MS, escalationAfterMs: undefined },
      });
    }
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(groupProbe).toHaveBeenCalledWith(-1235, 0);
    expect(groupProbe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  },
);

it("retains extinction ownership after EPERM until ESRCH", async () => {
  const { adapter, completeRoot, emit, close, groupProbe } = await createRelay("darwin");
  groupProbe.mockImplementationOnce(() => {
    throw Object.assign(new Error("synthetic unsignalable group"), { code: "EPERM" });
  });
  completeRoot();
  await adapter.wait();
  const settled = vi.fn();
  const extinction = adapter.waitForExtinction();
  void extinction.then(settled, settled);
  emit({ type: "closing", reason: "lineage-closed" });
  await nextTurn();
  expect(groupProbe).not.toHaveBeenCalled();
  close();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  await extinction;
  expect(groupProbe.mock.calls).toEqual([
    [-1235, 0],
    [-1235, 0],
  ]);
});

it.each(["before", "after"])(
  "joins forced stdio cleanup when control closes %s the force request",
  async (controlCloses) => {
    const {
      adapter,
      completeRoot,
      emit,
      closeControl,
      exitRelay,
      groupProbe,
      lineage,
      acknowledgements,
      cancellations,
      killSpy,
    } = await createRelay("darwin");
    completeRoot();
    await adapter.wait();
    lineage.end();
    groupProbe.mockReturnValue(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    expect(acknowledgements).toContainEqual(expect.objectContaining({ type: "closing-ack" }));
    const extinct = vi.fn();
    void adapter.waitForExtinction().then(extinct, extinct);
    if (controlCloses === "before") {
      closeControl();
      await nextTurn();
    }
    const finished = vi.fn();
    const closing = closeOwnedStdioProcess(adapter, { force: true });
    void closing.then(finished, finished);
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).not.toHaveBeenCalled();
    expect(extinct).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    if (controlCloses === "after") {
      closeControl();
      await nextTurn();
    }
    groupProbe.mockImplementation(() => {
      throw Object.assign(new Error("synthetic absent group"), { code: "ESRCH" });
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(killSpy).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(cancellations).toHaveLength(0);
    expect(finished).not.toHaveBeenCalled();
    expect(extinct).not.toHaveBeenCalled();
    exitRelay();
    await expect(closing).resolves.toMatchObject({
      reason: "forced-relay-exit",
      signalRequested: "SIGKILL",
      exit: { code: 0, signal: null },
    });
    expect(groupProbe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(cancellations).toHaveLength(0);
  },
);

it.each([
  ["kernel group", false, false, false, true, false],
  ["output EOF", false, false, false, false, true],
] as const)(
  "settles every pending owner join at the hard deadline while waiting for %s",
  async (leg, controlClose, relayExit, lineageEof, extinctionUnconfirmed, outputPending) => {
    const pending = {
      controlClose,
      relayExit,
      lineageEof,
      extinctionUnconfirmed,
      stdoutEnd: outputPending,
      stderrEnd: outputPending,
    };
    const relay = await createRelay("darwin");
    const { adapter, emit, stdout, stderr } = relay;
    emit({ type: "root-result", code: 23, signal: null });
    if (leg !== "output EOF") {
      relay.endOutput();
    }
    await nextTurn();
    const root = adapter.wait();
    const extinction = adapter.waitForExtinction();
    const finished = vi.fn();
    const outcomes = Promise.allSettled([root, extinction]).then((results) => {
      finished();
      return results;
    });
    if (leg === "kernel group") {
      relay.groupProbe.mockReturnValue(true);
    }
    // Adding the fixed grace at this fractional reading loses sub-millisecond precision.
    vi.spyOn(performance, "now").mockReturnValue(3192.0055);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    relay.close();
    await nextTurn();
    if (leg === "output EOF") {
      await expect(extinction).resolves.toBeUndefined();
    } else {
      await expect(root).resolves.toEqual({ code: 23, signal: null });
    }
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const results = await outcomes;
    const pendingIndex = leg === "output EOF" ? 0 : 1;
    expect(results[pendingIndex]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message:
          "service child cleanup did not complete before its hard deadline; pending: " +
          JSON.stringify({ closingReceipt: false, ...pending }),
      }),
    });
    expect(results[1 - pendingIndex]?.status).toBe("fulfilled");
    expect(stdout?.destroyed).toBe(true);
    expect(stderr?.destroyed).toBe(true);
    // Late native/output callbacks cannot replace a rejected join or erase a completed fact.
    relay.endOutput();
    relay.lineage.end();
    relay.exitRelay();
    expect(await Promise.allSettled([root, extinction])).toEqual(results);
    expect(relay.cancellations).toHaveLength(0);
  },
);

it.each([
  { clockJump: -60_000, shutdown: false },
  { clockJump: 60_000, shutdown: true },
])(
  "does not renew hard cleanup for repeated KILL, receipt, EOF or a $clockJump ms wall-clock jump (shutdown=$shutdown)",
  async ({ clockJump, shutdown }) => {
    const { adapter, emit, closeControl, cancellations, groupProbe, stdout, stderr } =
      await createRelay("darwin");
    vi.spyOn(performance, "now").mockReturnValue(3192.0055);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const settled = vi.fn();
    const outcomes = Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]);
    void outcomes.then(settled);
    runWithProcessCleanupBudget(
      shutdown ? { deadline: 3192.0055 + GRACEFUL_CANCEL_TIMEOUT_MS, warn: vi.fn() } : undefined,
      () => adapter.kill("SIGKILL"),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    adapter.kill("SIGKILL");
    vi.setSystemTime(Date.now() + clockJump);
    await vi.advanceTimersByTimeAsync(1_000);
    emit({ type: "closing", reason: "cancel" });
    await nextTurn();
    await vi.advanceTimersByTimeAsync(500);
    closeControl();
    await nextTurn();
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(cancellations).toHaveLength(1);
    expect(groupProbe).not.toHaveBeenCalled();
    expect(stdout?.destroyed).toBe(true);
    expect(stderr?.destroyed).toBe(true);
  },
);

it("cannot revive lost authority with a late closing receipt while output remains open", async () => {
  const { adapter, emit, cancellations, acknowledgements, endOutput, lineage } =
    await createRelay("darwin");
  emit({ type: "root-result", code: 23, signal: null });
  await nextTurn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const outcomes = Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]);
  lineage.destroy(new Error("synthetic lineage observation lost"));
  await nextTurn();
  await expect(adapter.waitForExtinction()).rejects.toThrow("cleanup identity lost");
  adapter.kill("SIGKILL");
  emit({ type: "closing", reason: "cancel" });
  await nextTurn();
  adapter.kill("SIGKILL");
  expect(acknowledgements).toHaveLength(0);
  expect(cancellations).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5_000);
  const results = await outcomes;
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(results[0]).toMatchObject({
    reason: expect.objectContaining({ message: expect.stringContaining("hard deadline") }),
  });
  endOutput();
  expect(await Promise.allSettled([adapter.wait(), adapter.waitForExtinction()])).toEqual(results);
});
