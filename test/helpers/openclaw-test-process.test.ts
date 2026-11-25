import { afterEach, expect, it, vi } from "vitest";
import type { ProcessExtinctionResult } from "../../src/process/supervisor/types.js";
import { createDeferred } from "./promise.js";

const { createChildAdapter } = vi.hoisted(() => ({ createChildAdapter: vi.fn() }));
// mock-isolation: Keep real process and spawn-broker initialization out of this fake-timer fixture.
vi.mock("../../src/process/supervisor/adapters/child.js", () => ({ createChildAdapter }));

import {
  GATEWAY_RESTART_TEST_KILL_MS,
  GATEWAY_RESTART_TEST_STOP_MS,
} from "./gateway-restart-budget.js";
import { createOpenClawTestProcess } from "./openclaw-test-process.js";

afterEach(() => {
  createChildAdapter.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function completedAdapter(extinction: Promise<ProcessExtinctionResult>) {
  const dispose = vi.fn();
  return {
    ready: Promise.resolve(),
    adapter: {
      onStdout() {},
      onStderr() {},
      onError() {},
      onExit() {},
      wait: async () => ({ code: 0, signal: null }),
      waitForExtinction: () => extinction,
      kill() {},
      dispose,
    },
  };
}

const processOptions = {
  argv: [process.execPath],
  cwd: process.cwd(),
  env: {},
  onError: (error: Error) => {
    throw error;
  },
  onSpawnCleanup() {},
};

it.for([
  undefined,
  { status: "confirmed" },
  { status: "uncertain", reason: "job-unavailable" },
  { status: "released", survivors: [{ pid: 12345 }] },
] satisfies ProcessExtinctionResult[])(
  "requires confirmed extinction before disposing (%j)",
  async (receipt) => {
    const startup = completedAdapter(Promise.resolve(receipt));
    createChildAdapter.mockResolvedValue(startup);
    const owner = await createOpenClawTestProcess(processOptions);
    owner.process.stdout.resume();
    owner.process.stderr.resume();
    const stopped = owner.stop(Date.now() + 1_000, () => {});
    if (receipt && receipt.status !== "confirmed") {
      await expect(stopped).rejects.toMatchObject({ cause: receipt });
      await expect(owner.stop(Date.now() + 1_000, () => {})).rejects.toMatchObject({
        cause: receipt,
      });
      expect(startup.adapter.dispose).not.toHaveBeenCalled();
    } else {
      await expect(stopped).resolves.toBe(true);
      expect(startup.adapter.dispose).toHaveBeenCalledOnce();
    }
  },
);

it("retains failed extinction alongside construction failure", async () => {
  const failure = new Error("command admission failed");
  const receipt = { status: "uncertain", reason: "job-unavailable" } as const;
  const onSpawnCleanup = vi.fn();
  createChildAdapter.mockImplementation(async (params) => {
    params.onSpawnCleanup(Promise.resolve(receipt));
    throw failure;
  });
  const result = createOpenClawTestProcess({ ...processOptions, onSpawnCleanup });
  await expect(result).rejects.toMatchObject({
    errors: [failure, expect.objectContaining({ cause: receipt })],
  });
  await expect(onSpawnCleanup.mock.calls[0]![0]).rejects.toMatchObject({ cause: receipt });
});

it.for(["construction", "readiness"] as const)(
  "aborts stalled %s at the startup deadline",
  async (phase) => {
    vi.useFakeTimers();
    const admitted = createDeferred();
    const cleanup = createDeferred<ProcessExtinctionResult>();
    const startup = completedAdapter(cleanup.promise);
    createChildAdapter.mockImplementation(async (params) => {
      params.onSpawnCleanup(cleanup.promise);
      params.abortSignal.addEventListener(
        "abort",
        () => admitted.reject(params.abortSignal.reason),
        { once: true },
      );
      if (phase === "construction") {
        await admitted.promise;
      }
      return { ...startup, ready: admitted.promise };
    });
    const created = createOpenClawTestProcess({
      ...processOptions,
      startDeadline: Date.now() + 25,
    });
    const owner = phase === "readiness" ? await created : undefined;
    owner?.process.stdout.resume();
    owner?.process.stderr.resume();
    let settled = false;
    const outcome = (owner?.started ?? created)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toBe(phase === "readiness");
    cleanup.resolve(undefined);
    expect(await outcome).toMatchObject({ message: "timeout waiting for gateway process startup" });
    if (owner) {
      await owner.stop(Date.now() + 1_000, () => {});
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("releases the startup deadline after admission without cancelling the running child", async () => {
  vi.useFakeTimers();
  const startup = completedAdapter(Promise.resolve());
  createChildAdapter.mockResolvedValue(startup);
  const owner = await createOpenClawTestProcess({
    ...processOptions,
    startDeadline: Date.now() + 25,
  });
  owner.process.stdout.resume();
  owner.process.stderr.resume();
  await owner.started;
  await vi.advanceTimersByTimeAsync(100);
  expect(createChildAdapter.mock.calls[0]![0].abortSignal.aborted).toBe(false);
  await owner.stop(Date.now() + 1_000, () => {});
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps caller cancellation first when readiness cleanup crosses the deadline", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const cancelled = new Error("caller cancelled startup");
  const ready = createDeferred();
  const startup = completedAdapter(Promise.resolve());
  createChildAdapter.mockResolvedValue({ ...startup, ready: ready.promise });
  const owner = await createOpenClawTestProcess({
    ...processOptions,
    signal: caller.signal,
    startDeadline: Date.now() + 25,
  });
  owner.process.stdout.resume();
  owner.process.stderr.resume();
  const outcome = owner.started.catch((error: unknown) => error);
  caller.abort(cancelled);
  await vi.advanceTimersByTimeAsync(25);
  const cleanupFailure = new Error("readiness cleanup failed");
  ready.reject(cleanupFailure);
  expect(await outcome).toMatchObject({ cause: cancelled, errors: [cancelled, cleanupFailure] });
  await owner.stop(Date.now() + 1_000, () => {});
  expect(vi.getTimerCount()).toBe(0);
});

it.for([false, true])(
  "bounds Gateway shutdown without the generic cutoff (hangs: %s)",
  async (hangs) => {
    vi.useFakeTimers();
    const completion = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
    const kill = vi.fn();
    createChildAdapter.mockResolvedValue({
      ready: Promise.resolve(),
      adapter: {
        pid: 12345,
        memoryRootPid: 12344,
        onStdout() {},
        onStderr() {},
        onError() {},
        onExit(listener: typeof onExit) {
          onExit = listener;
        },
        wait: () => completion.promise,
        waitForExtinction: () => completion.promise.then(() => {}),
        kill,
        dispose() {},
      },
    });
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const owner = await createOpenClawTestProcess({
      argv: [process.execPath],
      cwd: process.cwd(),
      env: {},
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
      onError: (error) => {
        throw error;
      },
      onSpawnCleanup() {},
    });
    owner.process.stdout.resume();
    owner.process.stderr.resume();
    expect(owner.process.memoryRootPid).toBe(12344);
    expect(owner.process.kill("SIGTERM")).toBe(true);
    expect(signal).toHaveBeenCalledWith(12345, "SIGTERM");
    await vi.advanceTimersByTimeAsync(6_300);
    expect(kill).not.toHaveBeenCalled();
    if (!hangs) {
      onExit(0, null);
      completion.resolve({ code: 0, signal: null });
      await owner.stop(Date.now() + 1_000, () => {});
      kill.mockClear();
      await vi.advanceTimersByTimeAsync(GATEWAY_RESTART_TEST_STOP_MS);
      expect(kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    await vi.advanceTimersByTimeAsync(GATEWAY_RESTART_TEST_KILL_MS - 6_301);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(GATEWAY_RESTART_TEST_KILL_MS).toBeLessThan(GATEWAY_RESTART_TEST_STOP_MS);
    onExit(null, "SIGKILL");
    completion.resolve({ code: null, signal: "SIGKILL" });
    await owner.stop(Date.now() + 1_000, () => {});
    expect(vi.getTimerCount()).toBe(0);
  },
);
