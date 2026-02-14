/**
 * Test: before_compaction & after_compaction hook wiring
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

describe("compaction hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockReset();
    hookMocks.runner.runBeforeCompaction.mockResolvedValue(undefined);
    hookMocks.runner.runAfterCompaction.mockReset();
    hookMocks.runner.runAfterCompaction.mockResolvedValue(undefined);
  });

  it("calls runBeforeCompaction in handleAutoCompactionStart", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleAutoCompactionStart } =
      await import("../agents/pi-embedded-subscribe.handlers.compaction.js");

    const ctx = {
      params: { runId: "r1", session: { messages: [1, 2, 3] } },
      state: { compactionInFlight: false },
      log: { debug: vi.fn(), warn: vi.fn() },
      incrementCompactionCount: vi.fn(),
      ensureCompactionPromise: vi.fn(),
    };

    handleAutoCompactionStart(ctx as never);

    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);

    const [event] = hookMocks.runner.runBeforeCompaction.mock.calls[0];
    expect(event.messageCount).toBe(3);
  });

  it("calls runAfterCompaction when willRetry is false", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleAutoCompactionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.compaction.js");

    const ctx = {
      params: { runId: "r2", session: { messages: [1, 2] } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      getCompactionCount: () => 1,
    };

    handleAutoCompactionEnd(
      ctx as never,
      {
        type: "auto_compaction_end",
        willRetry: false,
      } as never,
    );

    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(1);

    const [event] = hookMocks.runner.runAfterCompaction.mock.calls[0];
    expect(event.messageCount).toBe(2);
    expect(event.compactedCount).toBe(1);
  });

  it("does not call runAfterCompaction when willRetry is true", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleAutoCompactionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.compaction.js");

    const ctx = {
      params: { runId: "r3", session: { messages: [] } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), warn: vi.fn() },
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      getCompactionCount: () => 0,
    };

    handleAutoCompactionEnd(
      ctx as never,
      {
        type: "auto_compaction_end",
        willRetry: true,
      } as never,
    );

    expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
  });
});
