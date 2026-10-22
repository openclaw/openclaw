import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { closeOwnedStdioProcess } from "../owned-stdio.js";
import * as childAdapter from "./adapters/child.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import { runWithProcessCleanupBudget } from "./cleanup-budget.js";
import {
  closeStub,
  mockWritableRelay as buildRelay,
  observeSettlement,
  relayDefaults,
  relayPeer,
} from "./service-child-relay-host.fixture.test-support.js";
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

const cleanups: Array<() => void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  await nextTurn();
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

// These fixtures model POSIX process-group receipts, not Linux subreaper certificates.
async function createRelay(platform: "darwin" | "win32", retainLineage = false) {
  mockProcessPlatform(platform);
  return createRelayFixture(
    platform,
    retainLineage,
    (child) => mocks.spawn.mockReturnValue(child),
    (cleanup) => cleanups.push(cleanup),
  );
}

const mockWritableRelay = () => buildRelay((child) => mocks.spawn.mockReturnValue(child));
const startRelay = (
  params: Partial<
    Parameters<typeof createServiceChildRelayAdapter>[0] & { ownedWorker?: false }
  > = {},
) => createServiceChildRelayAdapter({ ...relayDefaults, ...params });

it.each(["before", "after"] as const)(
  "checks launch policy %s relay start dispatch",
  async (timing) => {
    const stub = mockWritableRelay();
    let allowed = true;
    mocks.spawn.mockImplementation(() => {
      if (timing === "before") {
        allowed = false;
      }
      return stub.child;
    });
    const starting = startRelay({
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
        const { emit } = relayPeer(stub);
        allowed = false;
        emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
        const adapter = await starting;
        emit({ type: "root-result", code: 0, signal: null });
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
    const stub = mockWritableRelay();
    const writes = vi.spyOn(stub.control, "write");
    const grantReached = createDeferredCore();
    let current = true;
    let released = false;
    const starting = startRelay({
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
    const { emit } = relayPeer(stub);
    const rejected =
      authority === "current" ? undefined : expect(starting).rejects.toThrow("launch revoked");
    current = authority !== "revoked";
    emit({ type: "prepared" });
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
        emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
        const adapter = await starting;
        expect(released).toBe(true);
        emit({ type: "root-result", code: 0, signal: null });
        stub.stdout.emit("end");
        stub.stderr.emit("end");
        await adapter.wait();
      }
    } finally {
      closeStub(stub);
    }
  },
);

it("checks input authority after readiness before writing private stdin", async () => {
  const stub = mockWritableRelay();
  const inputWrites = vi.spyOn(stub.child.stdin!, "write");
  const preparing = createDeferredCore();
  const releasePreparation = createDeferredCore();
  const revoked = new Error("private input authority revoked");
  let current = true;
  const prepareInput = vi.fn(async () => {
    preparing.resolve();
    await releasePreparation.promise;
    if (!current) {
      throw revoked;
    }
  });
  const starting = startRelay({
    input: "private prompt",
    prepareInput,
  });
  const outcome = starting.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    const { emit } = relayPeer(stub);
    expect(prepareInput).not.toHaveBeenCalled();
    emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    await Promise.race([preparing.promise, outcome]);
    expect(prepareInput).toHaveBeenCalledOnce();
    expect(inputWrites).not.toHaveBeenCalled();
    current = false;
    releasePreparation.resolve();
    expect(await outcome).toBe(revoked);
    expect(inputWrites).not.toHaveBeenCalled();
    expect(stub.killMock).toHaveBeenCalledWith("SIGKILL");
  } finally {
    releasePreparation.resolve();
    closeStub(stub);
    await outcome;
  }
});

it("reports cleanup uncertainty when deferred start delivery fails after abort", async () => {
  const stub = mockWritableRelay();
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
  const starting = startRelay({
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
  mockProcessPlatform("win32");
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

it.each(["root", "cancellation"] as const)(
  "publishes and replays %s exit while retaining the independent closing receipt",
  async (source) => {
    const { adapter, start, acknowledgements, emit, completeRoot, endOutput, close } =
      await createRelay("darwin");
    const onExit = vi.fn();
    adapter.onExit(onExit);
    const exit = source === "root" ? [0, null] : [null, "SIGKILL"];
    if (source === "root") {
      expect(start.acknowledgeClosing).toBe(true);
      emit({ type: "root-result", code: 0, signal: null });
      await nextTurn();
      expect(onExit).toHaveBeenCalledExactlyOnceWith(...exit);
      const lateExit = vi.fn();
      adapter.onExit(lateExit);
      expect(lateExit).toHaveBeenCalledExactlyOnceWith(...exit);
      completeRoot();
      await adapter.wait();
    } else {
      adapter.kill("SIGKILL");
      endOutput();
    }
    const closing = emit({ type: "closing", reason: "lineage-closed" });
    const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
    await nextTurn();
    if (source === "root") {
      expect(acknowledgements).toEqual([
        {
          type: "closing-ack",
          generation: closing.generation,
          sequence: 1,
          closingSequence: closing.sequence,
        },
      ]);
      expect(settled).not.toHaveBeenCalled();
    }
    close();
    if (source === "cancellation") {
      await expect(adapter.wait()).resolves.toEqual({ code: null, signal: "SIGKILL" });
    }
    await expect(extinction).resolves.toBeUndefined();
    if (source === "cancellation") {
      expect(onExit).toHaveBeenCalledExactlyOnceWith(...exit);
      const lateExit = vi.fn();
      adapter.onExit(lateExit);
      expect(lateExit).toHaveBeenCalledExactlyOnceWith(...exit);
    }
  },
);

it("keeps cleanup authority when a root-exit consumer ends already-closed stdin", async () => {
  const stub = mockWritableRelay();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("synthetic missing process group"), { code: "ESRCH" });
  });
  const write = stub.control.write.bind(stub.control);
  vi.spyOn(stub.control, "write").mockImplementation((chunk, encoding, callback) => {
    const message: unknown = JSON.parse(chunk.toString());
    if (isRecord(message) && message.type === "stdin-end") {
      callback?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      return false;
    }
    return write(chunk, encoding, callback);
  });
  const starting = startRelay({
    stdinMode: "pipe-open",
    terminateOnHostLoss: true,
  });
  const { emit } = relayPeer(stub);
  emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
  const adapter = await starting;
  adapter.onExit(() => adapter.stdin!.end());
  const extinction = adapter.waitForExtinction();
  void extinction.catch(() => {});
  try {
    emit({ type: "root-result", code: 0, signal: null });
    stub.stdout.end();
    stub.stderr.end();
    await nextTurn();
    emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    stub.lineage.end();
    stub.control.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
    await expect(extinction).resolves.toBeUndefined();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  } finally {
    closeStub(stub);
    adapter.dispose();
  }
});

it("keeps an observed Windows root result independent of failed extinction", async () => {
  const { adapter, emit, endOutput, close } = await createRelay("win32");
  adapter.kill("SIGTERM");
  emit({ type: "root-result", code: 23, signal: null });
  await nextTurn();
  const [root, settled] = observeSettlement(adapter.wait());
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
    const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
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
  const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
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
  const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
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
    const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
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
  const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
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
        cause: expect.objectContaining({
          message: expect.stringContaining(`"durationMs":${GRACEFUL_CANCEL_TIMEOUT_MS}`),
        }),
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
  const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
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
    const [, extinct] = observeSettlement(adapter.waitForExtinction());
    if (controlCloses === "before") {
      closeControl();
      await nextTurn();
    }
    const [closing, finished] = observeSettlement(closeOwnedStdioProcess(adapter, { force: true }));
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
