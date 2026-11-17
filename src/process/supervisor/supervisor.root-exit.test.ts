import { afterEach, expect, it, vi } from "vitest";
import { createProcessAdapterEvents } from "./adapters/process-events.js";
import { createProcessSupervisor } from "./supervisor.js";
import { createStubChildAdapter } from "./supervisor.test-support.js";

const spawn = vi.hoisted(() => vi.fn());
// mock-isolation: This fixture controls root exit and output closure independently.
vi.mock("./adapters/child.js", () => ({ createChildAdapter: spawn }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it
  .skipIf(process.platform === "win32")
  .each(["complete", "cancel-before-exit", "cancel-during-drain", "external", "internal"])(
  "bounds exec output without releasing cleanup or cancellation ownership (%s)",
  async (scenario) => {
    vi.useFakeTimers();
    const events = createProcessAdapterEvents();
    const adapter = { ...createStubChildAdapter(), onExit: events.onExit };
    spawn.mockResolvedValue({ adapter, ready: Promise.resolve() });
    const supervisor = createProcessSupervisor();
    const run = await supervisor.spawn({
      mode: "child",
      argv: ["synthetic-command"],
      executionIntent: scenario === "internal" ? "gateway-internal" : "agent-tool",
      ...(scenario === "external" ? { cleanupOwnership: "external" } : {}),
    });
    const settled = vi.fn();
    void run.wait().then(settled);
    if (scenario === "cancel-before-exit") {
      run.cancel();
    }
    adapter.emitStdout("done\n");
    events.emitExit(7, null);
    if (scenario === "cancel-during-drain") {
      run.cancel();
    }
    try {
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      adapter.emitStdout("tail\n");
      await vi.advanceTimersByTimeAsync(1);
      if (scenario === "complete") {
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ exitCode: 7, stdout: "done\ntail\n" }),
        );
        const activity = run.activity.lastOutputAtMs;
        adapter.emitStdout("late\n");
        expect(run.activity.lastOutputAtMs).toBe(activity);
        expect(adapter.killMock).not.toHaveBeenCalled();
        expect(adapter.disposeMock).not.toHaveBeenCalled();
      } else {
        expect(settled).not.toHaveBeenCalled();
      }
    } finally {
      adapter.settle(7);
      await run.wait();
      await supervisor.shutdown();
    }
  },
);
