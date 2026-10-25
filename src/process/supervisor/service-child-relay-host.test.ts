import assert from "node:assert/strict";
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
async function createRelay(platform: "darwin" | "win32" = "darwin", retainLineage = false) {
  mockProcessPlatform(platform);
  return createRelayFixture(
    platform,
    retainLineage,
    (child) => mocks.spawn.mockReturnValue(child),
    (cleanup) => cleanups.push(cleanup),
  );
}

const startRelay = (
  params: Partial<
    Parameters<typeof createServiceChildRelayAdapter>[0] & { ownedWorker?: false }
  > = {},
) => createServiceChildRelayAdapter({ ...relayDefaults, ...params });

function mockWritableRelay() {
  const stub = buildRelay((child) => mocks.spawn.mockReturnValue(child));
  cleanups.push(() => {
    closeStub(stub);
    stub.stdout.destroy();
    stub.stderr.destroy();
    stub.child.stdin?.destroy();
  });
  return stub;
}

const failGroup = (code: string) => () => {
  throw Object.assign(new Error(`synthetic ${code}`), { code });
};
function clock(now = 10_000) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return vi.spyOn(performance, "now").mockReturnValue(now);
}
const rootResult = { code: 0, signal: null };

it.each(["dispatch-revoked", "post-dispatch", "prepared-current", "prepared-revoked"] as const)(
  "checks launch authority at its owning boundary: %s",
  async (phase) => {
    const stub = mockWritableRelay();
    const prepared = phase.startsWith("prepared");
    const revoked = phase.endsWith("revoked");
    const writes = vi.spyOn(stub.control, "write");
    const grantReached = createDeferredCore();
    let current = true;
    let released = false;
    const assertAuthority = () => {
      if (!current) {
        throw new Error("launch authority revoked");
      }
    };
    mocks.spawn.mockImplementation(() => {
      if (phase === "dispatch-revoked") {
        current = false;
      }
      return stub.child;
    });
    const starting = startRelay({
      beforeSpawn: prepared ? undefined : assertAuthority,
      initiateSpawn: prepared
        ? (launch, settlement) => {
            grantReached.resolve();
            assertAuthority();
            void settlement?.then(() => {
              released = true;
            });
            return launch();
          }
        : undefined,
    });
    const rejected = revoked
      ? expect(starting).rejects.toThrow("launch authority revoked")
      : undefined;
    if (phase === "dispatch-revoked") {
      await rejected;
      expect(stub.sendMock).not.toHaveBeenCalled();
      return;
    }
    const { emit } = relayPeer(stub);
    current = phase === "prepared-current";
    if (prepared) {
      emit({ type: "prepared" });
      await grantReached.promise;
      expect(released).toBe(false);
      if (rejected) {
        await rejected;
      }
      expect(writes.mock.calls.some(([chunk]) => String(chunk).includes('"type":"launch"'))).toBe(
        !revoked,
      );
      if (revoked) {
        return;
      }
    }
    emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const adapter = await starting;
    if (prepared) {
      expect(released).toBe(true);
    }
    emit({ type: "root-result", ...rootResult });
    stub.stdout.emit("end");
    stub.stderr.emit("end");
    expect((await adapter.wait()).code).toBe(0);
    if (!prepared) {
      expect(stub.killMock).not.toHaveBeenCalled();
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
    expect(prepareInput).not.toHaveBeenCalled();
    const { emit } = relayPeer(stub);
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
  const starting = startRelay({ abortSignal: abort.signal });
  await nextTurn();
  expect(stub.killMock).not.toHaveBeenCalled();

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
    const { adapter, floodControl, killSpy, close } = await createRelay();
    const parseSpy = vi.spyOn(JSON, "parse");
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

// The shared event replay is covered by adapters/child.events.test.ts.
it("publishes a confirmed cancellation exit and retains it for late subscribers", async () => {
  const f = await createRelay();
  const onExit = vi.fn();
  f.adapter.onExit(onExit);
  f.adapter.kill("SIGKILL");
  f.endOutput();
  f.emit({ type: "closing", reason: "lineage-closed" });
  const extinction = f.adapter.waitForExtinction();
  await nextTurn();
  f.close();
  await expect(f.adapter.wait()).resolves.toEqual({ code: null, signal: "SIGKILL" });
  await expect(extinction).resolves.toBeUndefined();
  expect(onExit).toHaveBeenCalledExactlyOnceWith(null, "SIGKILL");
  const lateExit = vi.fn();
  f.adapter.onExit(lateExit);
  expect(lateExit).toHaveBeenCalledExactlyOnceWith(null, "SIGKILL");
});

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

it.each([
  ["darwin", true],
  ["win32", true],
  ["darwin", false],
] as const)(
  "settles failed cancellation against closing authority (%s, receipt=%s)",
  async (platform, receipt) => {
    const { adapter, cancellations, emit, completeRoot, close } = await createRelay(platform);
    const onError = vi.fn();
    adapter.onError(onError);
    completeRoot();
    const [extinction, settled] = observeSettlement(adapter.waitForExtinction());
    adapter.kill();
    expect(cancellations).toHaveLength(1);
    if (receipt) {
      emit({ type: "closing", reason: "lineage-closed" });
    }
    cancellations[0]!(new Error("synthetic closed control channel"));
    if (receipt) {
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      close();
      await expect(extinction).resolves.toBeUndefined();
    } else {
      await expect(extinction).rejects.toThrow("service child cleanup identity lost");
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("cleanup identity lost") }),
        "process",
      );
    }
    await expect(adapter.wait()).resolves.toEqual(rootResult);
  },
);

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

it.each(["retry", "EPERM", "EIO"] as const)(
  "joins kernel disappearance after relay reaping: %s",
  async (mode) => {
    const f = await createRelay();
    const cause = Object.assign(new Error("synthetic group failure"), {
      code: mode === "retry" ? "EPERM" : mode,
    });
    f.groupProbe.mockImplementation(() => {
      throw cause;
    });
    f.completeRoot();
    await expect(f.adapter.wait()).resolves.toEqual(rootResult);
    f.lineage.end();
    await nextTurn();
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    f.emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    const [extinction, settled] = observeSettlement(f.adapter.waitForExtinction());
    if (mode !== "retry") {
      now.mockReturnValue(15_000);
    }
    f.closeControl();
    await nextTurn();
    expect(settled).not.toHaveBeenCalled();
    expect(f.groupProbe).not.toHaveBeenCalled();
    if (mode === "retry") {
      f.groupProbe
        .mockImplementationOnce(() => {
          throw cause;
        })
        .mockImplementation(failGroup("ESRCH"));
    }
    f.exitRelay();
    if (mode === "retry") {
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      await expect(extinction).resolves.toBeUndefined();
    } else {
      await expect(extinction).rejects.toThrow(
        mode === "EIO" ? "owned process group" : "hard deadline",
      );
      if (mode === "EIO") {
        await expect(extinction).rejects.toSatisfy(
          (error: unknown) => error instanceof Error && error.cause === cause,
        );
      } else {
        await expect(extinction).rejects.toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringContaining(`"durationMs":${GRACEFUL_CANCEL_TIMEOUT_MS}`),
          }),
        });
      }
    }
    expect(f.groupProbe).toHaveBeenCalledWith(-1235, 0);
    expect(f.groupProbe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  },
);

it.each(["before", "after", "queued", "short"] as const)(
  "adopts closing cleanup without renewing its deadline: %s",
  async (order) => {
    const f = await createRelay();
    const now = clock();
    if (order === "queued") {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"],
      });
    }
    const warn = vi.fn();
    const deadline = order === "short" ? 12_000 : 20_000;
    const shutdown = (signal: "SIGTERM" | "SIGKILL" = "SIGTERM", until = deadline) =>
      runWithProcessCleanupBudget({ deadline: until, warn }, () => f.adapter.kill(signal));
    const [extinction, settled] = observeSettlement(f.adapter.waitForExtinction());
    const outcomes = Promise.allSettled([f.adapter.wait(), extinction]);
    if (order === "before" || order === "short") {
      shutdown();
    }
    f.completeRoot();
    f.emit({ type: "closing", reason: "cancel" });
    f.lineage.end();
    const turn = () => (order === "queued" ? vi.advanceTimersByTimeAsync(0) : nextTurn());
    await turn();
    f.closeControl();
    await turn();
    if (order === "after") {
      now.mockReturnValue(11_000);
      await vi.advanceTimersByTimeAsync(1_000);
      shutdown();
    } else if (order === "queued") {
      now.mockReturnValue(15_000);
      vi.advanceTimersByTime(5_000);
      shutdown();
      await vi.advanceTimersByTimeAsync(1);
    }
    if (order === "short") {
      now.mockReturnValue(11_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.killSpy).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      shutdown("SIGKILL", 30_000);
      now.mockReturnValue(12_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(warn).not.toHaveBeenCalled();
      return;
    }
    if (order !== "queued") {
      now.mockReturnValue(16_000);
      await vi.advanceTimersByTimeAsync(order === "before" ? 6_000 : 5_000);
    }
    expect(settled).not.toHaveBeenCalled();
    f.exitRelay();
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: rootResult },
      { status: "fulfilled", value: undefined },
    ]);
    if (order !== "queued") {
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "service child relay required forced retirement; cleanup completed",
      );
    }
  },
);

it.each(["before", "after"])(
  "joins forced stdio cleanup when control closes %s the force request",
  async (controlCloses) => {
    const f = await createRelay();
    f.completeRoot();
    await f.adapter.wait();
    f.lineage.end();
    f.groupProbe.mockReturnValue(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    expect(f.acknowledgements).toContainEqual(expect.objectContaining({ type: "closing-ack" }));
    const [, extinct] = observeSettlement(f.adapter.waitForExtinction());
    if (controlCloses === "before") {
      f.closeControl();
      await nextTurn();
    }
    const [closing, finished] = observeSettlement(
      closeOwnedStdioProcess(f.adapter, { force: true }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).not.toHaveBeenCalled();
    expect(extinct).not.toHaveBeenCalled();
    expect(f.killSpy).not.toHaveBeenCalled();
    if (controlCloses === "after") {
      f.closeControl();
      await nextTurn();
    }
    f.groupProbe.mockImplementation(() => {
      throw Object.assign(new Error("synthetic absent group"), { code: "ESRCH" });
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.killSpy).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(f.cancellations).toHaveLength(0);
    expect(finished).not.toHaveBeenCalled();
    expect(extinct).not.toHaveBeenCalled();
    f.exitRelay();
    await expect(closing).resolves.toMatchObject({
      reason: "forced-relay-exit",
      signalRequested: "SIGKILL",
      exit: { code: 0, signal: null },
    });
    expect(f.groupProbe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(f.cancellations).toHaveLength(0);
  },
);

it.each(["kernel group", "output EOF"])(
  "settles every pending owner join at the hard deadline while waiting for %s",
  async (leg) => {
    const relay = await createRelay();
    const { adapter, emit, stdout, stderr } = relay;
    emit({ type: "root-result", code: 23, signal: null });
    if (leg !== "output EOF") {
      relay.endOutput();
    }
    await nextTurn();
    const root = adapter.wait();
    const extinction = adapter.waitForExtinction();
    const [outcomes, finished] = observeSettlement(Promise.allSettled([root, extinction]));
    if (leg === "kernel group") {
      relay.groupProbe.mockReturnValue(true);
    }
    // Adding the fixed grace at this fractional reading loses sub-millisecond precision.
    clock(3192.0055);
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
        message: expect.stringContaining("hard deadline"),
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
      await createRelay();
    vi.spyOn(performance, "now").mockReturnValue(3192.0055);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const [outcomes, settled] = observeSettlement(
      Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]),
    );
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
    await createRelay();
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

// Bundle serialization/redaction belongs to diagnostic-stability-bundle.test.ts:
// "preserves redacted shutdown causes and stacks through bundle readback".
it.each(["lineage", "signal"] as const)(
  "retains payload-free owner evidence after %s failure",
  async (failure) => {
    const stub = mockWritableRelay();
    const groupProbe = vi.spyOn(process, "kill").mockImplementation(failGroup("ESRCH"));
    const privateValues = ["command", "argument", "cwd", "environment", "input"].map(
      (field) => `fixture-${field}-private`,
    );
    const starting = startRelay({
      command: privateValues[0]!,
      args: [privateValues[1]!],
      cwd: privateValues[2],
      env: { FIXTURE_VALUE: privateValues[3] },
      input: privateValues[4],
    });
    const {
      start: { generation },
      emit,
    } = relayPeer(stub);
    emit({ type: "ready", commandPid: 2345, anchorPid: 3456 });
    const adapter = await starting;
    const outcomes = Promise.allSettled([adapter.wait(), adapter.waitForExtinction()]);
    const now = clock();
    emit({ type: "root-result", code: 23, signal: null });
    stub.stdout.end();
    stub.stderr.end();
    await nextTurn();
    await expect(adapter.wait()).resolves.toEqual({ code: 23, signal: null });
    emit({ type: "closing", reason: "cancel" });
    await nextTurn();
    stub.control.destroy();
    if (failure === "lineage") {
      stub.disconnectMock();
      stub.emitExit(0);
    } else {
      stub.lineage.end();
      await nextTurn();
      groupProbe.mockReturnValue(true);
      stub.sendMock.mockImplementation((_message, ...args) => {
        args.findLast((arg) => typeof arg === "function")?.(
          Object.assign(new Error("retirement failed"), { code: "EIO" }),
        );
        return true;
      });
      adapter.kill("SIGKILL");
    }
    await nextTurn();
    now.mockReturnValue(15_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const results = await outcomes;
    const [root, extinction] = results;
    expect(root).toMatchObject({ status: "fulfilled", value: { code: 23, signal: null } });
    assert(extinction.status === "rejected" && extinction.reason instanceof Error);
    const error = extinction.reason;
    assert(error.cause instanceof Error);
    expect(error.message).toContain("hard deadline");
    expect(error.message).toContain(`"lineageEof":${failure === "lineage"}`);
    const ownerPrefix = "service child cleanup owner: ";
    expect(error.cause.message.startsWith(ownerPrefix)).toBe(true);
    const owner: unknown = JSON.parse(error.cause.message.slice(ownerPrefix.length));
    expect(owner).toMatchObject({
      generation,
      relayPid: 1234,
      anchorPid: 3456,
      commandPid: 2345,
      treeOwnership: "process-group",
      durationMs: failure === "lineage" ? 0 : 5_000,
      ...(failure === "signal" ? { escalationAfterMs: 0 } : {}),
    });
    if (failure === "signal") {
      expect(error.cause.cause).toMatchObject({ code: "EIO", message: "retirement failed" });
    }
    for (const value of privateValues) {
      expect(error.message + error.cause.message).not.toContain(value);
    }
  },
);
