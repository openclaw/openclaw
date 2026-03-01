/**
 * Test: before_compaction & after_compaction hook wiring
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { emitAgentEvent } from "../infra/agent-events.js";

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
  let handleAutoCompactionStart: typeof import("../agents/pi-embedded-subscribe.handlers.compaction.js").handleAutoCompactionStart;
  let handleAutoCompactionEnd: typeof import("../agents/pi-embedded-subscribe.handlers.compaction.js").handleAutoCompactionEnd;

  beforeAll(async () => {
    ({ handleAutoCompactionStart, handleAutoCompactionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.compaction.js"));
  });

  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runBeforeCompaction.mockResolvedValue(undefined);
    hookMocks.runner.runAfterCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockResolvedValue(undefined);
    vi.mocked(emitAgentEvent).mockClear();
  });

  it("calls runBeforeCompaction in handleAutoCompactionStart", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = {
      params: {
        runId: "r1",
        sessionKey: "agent:main:web-abc123",
        session: { messages: [1, 2, 3], sessionFile: "/tmp/test.jsonl" },
        onAgentEvent: vi.fn(),
      },
      state: { compactionInFlight: false },
      log: { debug: vi.fn(), warn: vi.fn() },
      incrementCompactionCount: vi.fn(),
      ensureCompactionPromise: vi.fn(),
    };

    handleAutoCompactionStart(ctx as never);

    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);

    const beforeCalls = hookMocks.runner.runBeforeCompaction.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    const event = beforeCalls[0]?.[0] as
      | { messageCount?: number; messages?: unknown[]; sessionFile?: string }
      | undefined;
    expect(event?.messageCount).toBe(3);
    expect(event?.messages).toEqual([1, 2, 3]);
    expect(event?.sessionFile).toBe("/tmp/test.jsonl");
    const hookCtx = beforeCalls[0]?.[1] as { sessionKey?: string } | undefined;
    expect(hookCtx?.sessionKey).toBe("agent:main:web-abc123");
    expect(ctx.ensureCompactionPromise).toHaveBeenCalledTimes(1);
    expect(emitAgentEvent).toHaveBeenCalledWith({
      runId: "r1",
      stream: "compaction",
      data: { phase: "start" },
    });
    expect(ctx.params.onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: { phase: "start" },
    });
  });

  it("calls runAfterCompaction when willRetry is false", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = {
      params: { runId: "r2", session: { messages: [1, 2] } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      incrementCompactionCount: vi.fn(),
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

    const afterCalls = hookMocks.runner.runAfterCompaction.mock.calls as unknown as Array<
      [unknown]
    >;
    const event = afterCalls[0]?.[0] as
      | { messageCount?: number; compactedCount?: number }
      | undefined;
    expect(event?.messageCount).toBe(2);
    expect(event?.compactedCount).toBe(1);
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(emitAgentEvent).toHaveBeenCalledWith({
      runId: "r2",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });
  });

  it("does not call runAfterCompaction when willRetry is true", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = {
      params: { runId: "r3", session: { messages: [] } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), warn: vi.fn() },
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      maybeResolveCompactionWait: vi.fn(),
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
    expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(emitAgentEvent).toHaveBeenCalledWith({
      runId: "r3",
      stream: "compaction",
      data: { phase: "end", willRetry: true },
    });
  });

  it("resets stale assistant usage after final compaction", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "response one",
        usage: { totalTokens: 180_000, input: 100, output: 50 },
      },
      {
        role: "assistant",
        content: "response two",
        usage: { totalTokens: 181_000, input: 120, output: 60 },
      },
    ];

    const ctx = {
      params: { runId: "r4", session: { messages } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      getCompactionCount: () => 1,
      incrementCompactionCount: vi.fn(),
    };

    handleAutoCompactionEnd(
      ctx as never,
      {
        type: "auto_compaction_end",
        willRetry: false,
      } as never,
    );

    const assistantOne = messages[1] as { usage?: unknown };
    const assistantTwo = messages[2] as { usage?: unknown };
    expect(assistantOne.usage).toEqual(makeZeroUsageSnapshot());
    expect(assistantTwo.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("does not clear assistant usage while compaction is retrying", () => {
    const messages = [
      {
        role: "assistant",
        content: "response",
        usage: { totalTokens: 184_297, input: 130_000, output: 2_000 },
      },
    ];

    const ctx = {
      params: { runId: "r5", session: { messages } },
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

    const assistant = messages[0] as { usage?: unknown };
    expect(assistant.usage).toEqual({ totalTokens: 184_297, input: 130_000, output: 2_000 });
  });
});
