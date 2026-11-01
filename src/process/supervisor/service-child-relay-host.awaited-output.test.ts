import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  closeStub,
  mockWritableRelay,
  observeSettlement,
  relayDefaults,
  relayPeer,
} from "./service-child-relay-host.fixture.test-support.js";
import { createServiceChildRelayAdapter as startServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createProcessSupervisor } from "./supervisor.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  await nextTurn();
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mockLinuxRelay = () =>
  mockWritableRelay((child) => mocks.spawn.mockReturnValue(child), "linux");

it.for([false, true])(
  "joins accepted stdout after identity loss while preserving an observed root (root observed=%s)",
  async (rootObserved, { signal }) => {
    const stub = mockLinuxRelay();
    const starting = startServiceChildRelayAdapter({
      ...relayDefaults,
      stdoutConsumption: "awaited",
      ownedWorker: true,
      env: {},
      cleanupBinding: {
        databasePath: "/synthetic/state.sqlite",
        externallySupervised: false,
        launchId: "synthetic-worker",
        planHash: "a".repeat(64),
        supervisor: { pid: 101, startTime: 1 },
      },
    });
    const { start, emit } = relayPeer(stub);
    expect(start.treeOwnership).toBeUndefined();
    expect(stub.killSpy).toHaveBeenCalledWith(0, 0);
    emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const { adapter, ready } = await starting;
    await ready;
    const entered = createDeferred();
    const release = createDeferred();
    const chunks: string[] = [];
    const consumed = adapter.consumeStdout(async (chunk) => {
      chunks.push(chunk);
      if (chunks.length === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const [outcome, settled] = observeSettlement(adapter.wait());
    const results = Promise.allSettled([outcome, consumed]);
    try {
      stub.stdout.write("accepted");
      await entered.promise;
      if (rootObserved) {
        emit({ type: "root-result", code: 23, signal: null });
        await nextTurn();
      }
      stub.control.destroy();
      await expect(adapter.waitForExtinction()).rejects.toThrow("cleanup identity lost");
      expect(adapter.confirmExtinction()).toBe(false);
      stub.stdout.write(" late tail");
      await nextTurn();
      expect(chunks).toEqual(["accepted"]);
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      if (rootObserved) {
        await nextTurn();
        expect(settled).not.toHaveBeenCalled();
        stub.stdout.end(" final tail");
        stub.stderr.end();
        expect(await results).toEqual([
          { status: "fulfilled", value: { code: 23, signal: null } },
          { status: "fulfilled", value: undefined },
        ]);
        expect(chunks.join("")).toBe("accepted late tail final tail");
      } else {
        const identityLost = expect.stringContaining("cleanup identity lost");
        expect(await withinTest(results, signal)).toMatchObject([
          {
            status: "rejected",
            reason: {
              errors: expect.arrayContaining([expect.objectContaining({ message: identityLost })]),
            },
          },
          { status: "rejected" },
        ]);
        expect(chunks).toEqual(["accepted"]);
        expect(stub.stdout).toMatchObject({ destroyed: false, readableEnded: false });
        stub.stderr.end();
      }
      stub.lineage.end();
      stub.disconnectMock();
      stub.emitExit(0);
      await nextTurn();
      if (!rootObserved) {
        expect(adapter.confirmExtinction()).toBe(false);
        stub.stdout.end(" discarded tail");
        await nextTurn();
        expect(chunks).toEqual(["accepted"]);
      }
      expect(adapter.confirmExtinction()).toBe(true);
    } finally {
      release.resolve();
      stub.stdout.end();
      stub.stderr.end();
      stub.control.destroy();
      stub.lineage.end();
      stub.disconnectMock();
      stub.emitExit(0);
      await results;
      adapter.dispose();
    }
  },
);

// Real supervisor -> child -> relay; only the OS child and group-absence probe are synthetic.
async function startSupervisedRelay(
  options: { timeoutMs?: number; noOutputTimeoutMs?: number } = {},
) {
  const stub = mockLinuxRelay();
  const supervisor = createProcessSupervisor();
  const scopeKey = "relay-output";
  const closeScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  const starting = supervisor.spawn({
    mode: "anchored-shell",
    command: "synthetic-command",
    scopeKey,
    ...options,
  });
  // Scope admission is asynchronous; this is not a readiness delay in the product.
  await nextTurn();
  const { emit } = relayPeer(stub);
  cleanups.push(() => closeStub(stub));
  return {
    ...stub,
    supervisor,
    closeScope,
    starting,
    emit,
    finish() {
      emit({ type: "closing", reason: "lineage-closed" });
      stub.lineage.end();
      stub.control.destroy();
      stub.disconnectMock();
      stub.emitExit(0);
    },
    ready() {
      emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
      return starting;
    },
    endOutput() {
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
    },
  };
}

it("retains stderr construction errors through the actual caller", async () => {
  const f = await startSupervisedRelay();
  const cause = new Error("raw construction failure");
  f.child.stderr?.emit("error", cause);
  const run = await f.ready();
  const rejected = expect(run.wait()).rejects.toBe(cause);
  f.emit({ type: "root-result", code: 0, signal: null });
  f.endOutput();
  f.finish();
  await rejected;
  await expect(run.waitForExtinction?.()).rejects.toBe(cause);
  await expect(f.closeScope()).rejects.toBe(cause);
});

it("rejects premature stdout close after root exit through the actual caller", async () => {
  const f = await startSupervisedRelay();
  const run = await f.ready();
  const rejected = expect(run.wait()).rejects.toThrow("closed before EOF");
  f.emit({ type: "root-result", code: 0, signal: null });
  f.child.stdout?.emit("close");
  f.child.stderr?.emit("end");
  f.finish();
  await rejected;
  await expect(f.closeScope()).rejects.toThrow("closed before EOF");
});

it("retains a late raw error during cleanup without rewriting the terminal result", async () => {
  const f = await startSupervisedRelay();
  const run = await f.ready();
  f.child.stdout?.emit("data", Buffer.from("final tail"));
  f.emit({ type: "root-result", code: 0, signal: null });
  f.endOutput();
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
  const run = await f.ready();
  const settled = vi.fn();
  const cleanup = run.waitForExtinction?.();
  void cleanup?.then(settled, settled);
  f.emit({ type: "root-result", code: 0, signal: null });
  f.finish();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  f.child.stdout?.emit("data", Buffer.from("late final tail"));
  f.endOutput();
  expect((await run.wait()).stdout).toBe("late final tail");
  await cleanup;
  await expect(f.closeScope()).resolves.toBeUndefined();
});

it("counts raw-only construction activity without renewing the original overall deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const f = await startSupervisedRelay({ timeoutMs: 100, noOutputTimeoutMs: 60 });
    f.child.stdout?.emit("data", Buffer.from("before timeout"));
    await vi.advanceTimersByTimeAsync(40);
    f.child.stdout?.emit("data", Buffer.from([0xe2]));
    await vi.advanceTimersByTimeAsync(40);
    f.child.stdout?.emit("data", Buffer.from([0x82]));
    expect(f.killMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersToNextTimerAsync();
    const run = await f.starting;
    expect(await run.wait()).toMatchObject({ reason: "overall-timeout", stdout: "before timeout" });
    await expect(f.closeScope()).rejects.toThrow("construction aborted");
  } finally {
    vi.useRealTimers();
  }
});

it("reports native cleanup failure without waiting for output during shutdown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = await startSupervisedRelay({ timeoutMs: 10 });
  const run = await f.ready();
  f.child.stdout?.emit("data", Buffer.from("retained root output"));
  f.emit({ type: "root-result", code: 23, signal: null });
  // No closing receipt, and stdout/stderr intentionally never reach EOF until finally.
  f.control.destroy();
  f.lineage.end();
  f.disconnectMock();
  f.emitExit(0);
  await nextTurn();
  expect(run.waitForExtinction).toBeTypeOf("function");
  const [cleanup, settled] = observeSettlement(f.supervisor.shutdown());
  try {
    await nextTurn();
    const observed: unknown = settled.mock.calls[0]?.[0];
    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).toContain("cleanup identity lost");
    await expect(run.waitForExtinction?.()).rejects.toBe(observed);
  } finally {
    f.endOutput();
    const result = await run.wait();
    expect(result).toMatchObject({ stdout: "retained root output", exitCode: 23 });
    await cleanup.catch(() => undefined);
    await f.closeScope().catch(() => undefined);
    vi.useRealTimers();
  }
});
