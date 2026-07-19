/**
 * Test: before_compaction & after_compaction hook wiring
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { makeZeroUsageSnapshot } from "../agents/usage.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
  },
  emitAgentEvent: vi.fn(),
  performGatewaySessionReset: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: hookMocks.emitAgentEvent,
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: hookMocks.performGatewaySessionReset,
}));

import {
  handleCompactionEnd,
  handleCompactionStart,
} from "../agents/embedded-agent-subscribe.handlers.compaction.js";

describe("compaction hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runBeforeCompaction.mockResolvedValue(undefined);
    hookMocks.runner.runAfterCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockResolvedValue(undefined);
    hookMocks.emitAgentEvent.mockClear();
    hookMocks.performGatewaySessionReset.mockClear();
  });

  function createCompactionEndCtx(params: {
    runId: string;
    messages?: unknown[];
    sessionFile?: string;
    sessionKey?: string;
    agentId?: string;
    sessionId?: string;
    compactionCount?: number;
    withRetryHooks?: boolean;
    deferEmbeddedHookSessionReset?: (request: unknown) => void;
  }) {
    return {
      params: {
        runId: params.runId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        session: {
          messages: params.messages ?? [],
          sessionFile: params.sessionFile,
        },
        ...(params.deferEmbeddedHookSessionReset
          ? {
              deferEmbeddedHookSessionReset: params.deferEmbeddedHookSessionReset,
            }
          : {}),
      },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      incrementCompactionCount: vi.fn(),
      getCompactionCount: () => params.compactionCount ?? 0,
      noteCompactionTokensAfter: vi.fn(),
      getLastCompactionTokensAfter: vi.fn(() => undefined),
      ...(params.withRetryHooks
        ? {
            noteCompactionRetry: vi.fn(),
            resetForCompactionRetry: vi.fn(),
          }
        : {}),
    };
  }

  function getBeforeCompactionCall() {
    const beforeCalls = hookMocks.runner.runBeforeCompaction.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    return {
      event: beforeCalls[0]?.[0] as
        | { messageCount?: number; messages?: unknown[]; sessionFile?: string }
        | undefined,
      hookCtx: beforeCalls[0]?.[1] as { sessionKey?: string } | undefined,
    };
  }

  function getAfterCompactionCall() {
    const afterCalls = hookMocks.runner.runAfterCompaction.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    return {
      event: afterCalls[0]?.[0] as
        | {
            messageCount?: number;
            compactedCount?: number;
            sessionFile?: string;
          }
        | undefined,
      hookCtx: afterCalls[0]?.[1] as
        | {
            sessionKey?: string;
            api?: {
              resetSession?: (reason?: "new" | "reset") => Promise<unknown>;
            };
          }
        | undefined,
    };
  }

  function expectCompactionEvent(params: {
    call: ReturnType<typeof getBeforeCompactionCall> | ReturnType<typeof getAfterCompactionCall>;
    expectedEvent: Record<string, unknown>;
    expectedSessionKey?: string;
  }) {
    expect(params.call.event).toEqual(params.expectedEvent);
    if (params.expectedSessionKey !== undefined) {
      if (!params.call.hookCtx) {
        throw new Error("Expected compaction hook context");
      }
      expect(params.call.hookCtx).toEqual(
        expect.objectContaining({ sessionKey: params.expectedSessionKey }),
      );
    }
  }

  function runCompactionEnd(
    ctx: ReturnType<typeof createCompactionEndCtx> | Record<string, unknown>,
    event: {
      willRetry: boolean;
      result?: { summary: string; tokensAfter?: number };
      aborted?: boolean;
    },
  ) {
    return handleCompactionEnd(
      ctx as never,
      {
        type: "compaction_end",
        ...event,
      } as never,
    );
  }

  it("calls runBeforeCompaction in handleCompactionStart", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = {
      params: {
        runId: "r1",
        sessionKey: "agent:main:web-abc123",
        session: { messages: [1, 2, 3], sessionFile: "/tmp/test.jsonl" },
        onAgentEvent: vi.fn(),
      },
      state: { compactionInFlight: false },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      incrementCompactionCount: vi.fn(),
      ensureCompactionPromise: vi.fn(),
    };

    handleCompactionStart(ctx as never, {
      type: "compaction_start",
      reason: "threshold",
    });

    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expectCompactionEvent({
      call: getBeforeCompactionCall(),
      expectedEvent: {
        messageCount: 3,
        messages: [1, 2, 3],
        sessionFile: "/tmp/test.jsonl",
      },
      expectedSessionKey: "agent:main:web-abc123",
    });
    expect(ctx.ensureCompactionPromise).toHaveBeenCalledTimes(1);
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "r1",
      stream: "compaction",
      data: { phase: "start" },
    });
    expect(ctx.params.onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: { phase: "start" },
    });
  });

  it("calls runAfterCompaction when willRetry is false", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createCompactionEndCtx({
      runId: "r2",
      messages: [1, 2],
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:web-xyz",
      compactionCount: 1,
    });

    await runCompactionEnd(ctx, {
      willRetry: false,
      result: { summary: "compacted" },
    });

    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(1);
    expectCompactionEvent({
      call: getAfterCompactionCall(),
      expectedEvent: {
        messageCount: 2,
        compactedCount: 1,
        sessionFile: "/tmp/session.jsonl",
      },
      expectedSessionKey: "agent:main:web-xyz",
    });
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(undefined);
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "r2",
      stream: "compaction",
      data: { phase: "end", willRetry: false, completed: true },
    });
  });

  it("provides a deferred reset API to final after-compaction hooks", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const deferredReset = vi.fn();
    (hookMocks.runner.runAfterCompaction as Mock).mockImplementationOnce(
      async (_event: unknown, hookCtx: unknown) => {
        const api = (
          hookCtx as {
            api?: { resetSession?: (reason?: "new" | "reset") => unknown };
          }
        ).api;
        expect(api?.resetSession).toEqual(expect.any(Function));
        await api?.resetSession?.("reset");
      },
    );

    const ctx = createCompactionEndCtx({
      runId: "r2-reset",
      messages: [1, 2],
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:discord-public:cron:heartbeat",
      agentId: "discord-public",
      sessionId: "session-heartbeat",
      compactionCount: 1,
      deferEmbeddedHookSessionReset: deferredReset,
    });

    await runCompactionEnd(ctx, {
      willRetry: false,
      result: { summary: "compacted" },
    });

    expect(deferredReset).toHaveBeenCalledWith({
      key: "agent:discord-public:cron:heartbeat",
      agentId: "discord-public",
      reason: "reset",
      commandSource: "embedded-agent:hook",
    });
    expect(hookMocks.performGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("withholds the reset API without a run-owned after-compaction reset queue", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    (hookMocks.runner.runAfterCompaction as Mock).mockImplementationOnce(
      async (_event: unknown, hookCtx: unknown) => {
        expect((hookCtx as { api?: unknown }).api).toBeUndefined();
      },
    );

    const ctx = createCompactionEndCtx({
      runId: "r2-no-reset-queue",
      messages: [1, 2],
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:discord-public:cron:heartbeat",
      agentId: "discord-public",
      sessionId: "session-heartbeat",
      compactionCount: 1,
    });

    await runCompactionEnd(ctx, {
      willRetry: false,
      result: { summary: "compacted" },
    });

    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(1);
    expect(hookMocks.performGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("does not call runAfterCompaction when willRetry is true but still increments counter", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createCompactionEndCtx({
      runId: "r3",
      compactionCount: 1,
      withRetryHooks: true,
    });

    await runCompactionEnd(ctx, {
      willRetry: true,
      result: { summary: "compacted" },
    });

    expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
    // Counter is incremented even with willRetry — compaction succeeded (#38905)
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "r3",
      stream: "compaction",
      data: { phase: "end", willRetry: true, completed: true },
    });
  });

  it.each([
    ["does not increment counter when compaction was aborted", { willRetry: false, aborted: true }],
    [
      "does not increment counter when compaction has result but was aborted",
      { willRetry: false, result: { summary: "compacted" }, aborted: true },
    ],
    ["does not increment counter when result is undefined", { willRetry: false }],
  ] as const)("%s", async (_name, event) => {
    const ctx = createCompactionEndCtx({ runId: "r3c" });
    await runCompactionEnd(ctx, event);
    expect(ctx.incrementCompactionCount).not.toHaveBeenCalled();
  });

  it("resets stale assistant usage after final compaction", async () => {
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
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      getCompactionCount: () => 1,
      incrementCompactionCount: vi.fn(),
      noteCompactionTokensAfter: vi.fn(),
      getLastCompactionTokensAfter: vi.fn(() => undefined),
    };

    await runCompactionEnd(ctx, {
      willRetry: false,
      result: { summary: "compacted" },
    });

    const assistantOne = messages[1] as { usage?: unknown };
    const assistantTwo = messages[2] as { usage?: unknown };
    expect(assistantOne.usage).toEqual(makeZeroUsageSnapshot());
    expect(assistantTwo.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("does not clear assistant usage while compaction is retrying", async () => {
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
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      getCompactionCount: () => 0,
    };

    await runCompactionEnd(ctx, { willRetry: true });

    const assistant = messages[0] as { usage?: unknown };
    expect(assistant.usage).toEqual({
      totalTokens: 184_297,
      input: 130_000,
      output: 2_000,
    });
  });
});
