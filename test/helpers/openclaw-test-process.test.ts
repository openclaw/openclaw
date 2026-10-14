import { afterEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  vi.useRealTimers();
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
