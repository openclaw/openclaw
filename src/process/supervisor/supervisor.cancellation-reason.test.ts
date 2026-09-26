// Active process cancellation must keep one canonical terminal reason.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import { createStubChildAdapter, type StubChildAdapter } from "./supervisor.test-support.js";
import type { ProcessSupervisor, SpawnInput, TerminationReason } from "./types.js";

const { createChildAdapterMock, createPtyAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: async (
    ...args: Parameters<typeof import("./adapters/child.js").createChildAdapter>
  ) => ({
    adapter: await createChildAdapterMock(...args),
    ready: Promise.resolve(),
  }),
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: createPtyAdapterMock,
}));

function createCancellationTestAdapter() {
  return Object.assign(createStubChildAdapter({ pid: 4321 }), { supportsRawOutput: false });
}

type CancellationPath = "run-id" | "scope";

function cancelThrough(
  supervisor: ProcessSupervisor,
  path: CancellationPath,
  runId: string,
  scopeKey: string,
  reason: TerminationReason,
): void {
  if (path === "scope") {
    supervisor.cancelScope(scopeKey, reason);
    return;
  }
  supervisor.cancel(runId, reason);
}

const cancellationCases = [
  { mode: "child", first: "run-id", later: "run-id", firstReason: "manual-cancel" },
  { mode: "pty", first: "scope", later: "scope", firstReason: "overall-timeout" },
  { mode: "child", first: "run-id", later: "scope", firstReason: "no-output-timeout" },
  { mode: "pty", first: "scope", later: "run-id", firstReason: "manual-cancel" },
] as const;

describe("process supervisor first cancellation reason", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    vi.useFakeTimers();
  });

  it("keeps the first manual-cancel when a later construction deadline fires", async () => {
    const startup = createDeferred<StubChildAdapter>();
    createChildAdapterMock.mockReturnValueOnce(startup.promise);
    const supervisor = createProcessSupervisor();
    const runId = "manual-cancel-then-timeout";
    const pendingRun = supervisor.spawn({
      runId,
      mode: "child",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      timeoutMs: 25,
      stdinMode: "pipe-closed",
    });

    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    supervisor.cancel(runId, "manual-cancel");

    await vi.advanceTimersByTimeAsync(25);
    const constructionState = await Promise.race([
      pendingRun.then(
        () => "settled" as const,
        () => "rejected" as const,
      ),
      Promise.resolve().then(() => "pending" as const),
    ]);
    expect(constructionState).toBe("settled");

    const run = await pendingRun;
    await expect(run.wait()).resolves.toMatchObject({
      reason: "manual-cancel",
      timedOut: false,
      noOutputTimedOut: false,
    });
    expect(run.activity.resultSettled).toBe(true);

    const lateAdapter = createCancellationTestAdapter();
    const killed = createDeferred();
    lateAdapter.killMock.mockImplementation(() => killed.resolve());
    startup.resolve(lateAdapter);
    await killed.promise;
    expect(lateAdapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(lateAdapter.disposeMock).not.toHaveBeenCalled();
    lateAdapter.settle(null, "SIGKILL");
    await run.waitForExtinction?.();
    expect(lateAdapter.disposeMock).toHaveBeenCalled();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(cancellationCases)(
    "$mode: keeps $firstReason across $first then $later cancellation",
    async ({ mode, first, later, firstReason }) => {
      const adapter = createCancellationTestAdapter();
      const adapterMock = mode === "child" ? createChildAdapterMock : createPtyAdapterMock;
      adapterMock.mockResolvedValueOnce(adapter);

      const supervisor = createProcessSupervisor();
      const runId = `first-cancellation-${mode}`;
      const scopeKey = `scope:first-cancellation-${mode}`;
      const input: SpawnInput = {
        runId,
        scopeKey,
        mode,
        argv: [process.execPath, "-e", ""],
      };
      const run = await supervisor.spawn(input);
      const exitPromise = run.wait();

      cancelThrough(supervisor, first, runId, scopeKey, firstReason);
      for (const laterReason of [
        firstReason,
        ...(["manual-cancel", "overall-timeout", "no-output-timeout"] as const).filter(
          (reason) => reason !== firstReason,
        ),
      ]) {
        cancelThrough(supervisor, later, runId, scopeKey, laterReason);
        expect(run.activity.resultSettled, `after ${laterReason}`).toBe(false);
      }

      expect(adapter.killMock).toHaveBeenCalledTimes(1);

      const signal =
        process.platform === "win32" && firstReason !== "manual-cancel" ? "SIGKILL" : "SIGTERM";
      expect(adapter.killMock).toHaveBeenCalledWith(signal);
      adapter.settle(null, signal);

      await expect(exitPromise).resolves.toMatchObject({
        reason: firstReason,
        exitSignal: signal,
        timedOut: firstReason !== "manual-cancel",
        noOutputTimedOut: firstReason === "no-output-timeout",
      });
      expect(run.activity.resultSettled).toBe(true);
      expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
