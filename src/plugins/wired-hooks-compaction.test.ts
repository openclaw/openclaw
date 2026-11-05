import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
  },
  emitAgentEvent: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock(import("../infra/agent-events.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  emitAgentEvent: hookMocks.emitAgentEvent,
  emitAgentEventIfCurrent: vi.fn(() => true),
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

import {
  handleCompactionEnd,
  handleCompactionStart,
} from "../agents/embedded-agent-subscribe.handlers.lifecycle.js";

describe("compaction hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockClear();
    hookMocks.emitAgentEvent.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockResolvedValue(undefined);
    hookMocks.runner.runAfterCompaction.mockResolvedValue(undefined);
  });

  function createCompactionEndCtx({
    messages = [],
    sessionFile,
    compactionCount = 0,
    withRetryHooks,
    ...params
  }: {
    runId: string;
    messages?: unknown[];
    sessionFile?: string;
    sessionKey?: string;
    compactionCount?: number;
    withRetryHooks?: boolean;
    isTerminalAborted?: () => boolean;
  }) {
    return {
      params: {
        ...params,
        sessionPersistence: "detached" as const,
        onAgentEvent: vi.fn(),
        session: { messages, sessionFile },
      },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      ensureCompactionPromise: vi.fn(),
      incrementCompactionCount: vi.fn(),
      getCompactionCount: () => compactionCount,
      noteCompactionTokensAfter: vi.fn(),
      getLastCompactionTokensAfter: vi.fn(() => undefined),
      ...(withRetryHooks
        ? {
            noteCompactionRetry: vi.fn(),
            resetForCompactionRetry: vi.fn(),
          }
        : {}),
    };
  }

  const completedOutcome = {
    status: "completed",
    tokensBefore: 100,
    tokensAfter: 50,
    willRetry: false,
  } as const;

  function expectEndEvent(runId: string, outcome: string, willRetry = false) {
    const data = { phase: "end", outcome, completed: outcome === "completed", willRetry };
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId,
      stream: "compaction",
      data: outcome === "completed" ? data : expect.objectContaining(data),
    });
  }

  function runCompactionEnd(
    ctx: ReturnType<typeof createCompactionEndCtx> | Record<string, unknown>,
    outcome: Parameters<typeof handleCompactionEnd>[1]["outcome"] = completedOutcome,
  ) {
    return handleCompactionEnd(
      ctx as never,
      {
        type: "compaction_end",
        reason: "threshold",
        outcome,
      } as never,
    );
  }

  function assistant(totalTokens: number, input: number, output: number) {
    return { role: "assistant", content: "response", usage: { totalTokens, input, output } };
  }

  it("calls runBeforeCompaction in handleCompactionStart", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createCompactionEndCtx({
      runId: "r1",
      sessionKey: "agent:main:web-abc123",
      messages: [1, 2, 3],
      sessionFile: "/tmp/test.jsonl",
    });
    ctx.state.compactionInFlight = false;

    handleCompactionStart(ctx as never, { type: "compaction_start", reason: "threshold" });

    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: 3, messages: [1, 2, 3], sessionFile: "/tmp/test.jsonl" },
      { sessionKey: "agent:main:web-abc123" },
    );
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

  it.each([
    ["completed", completedOutcome, false],
    ["terminal abort after completion", completedOutcome, true],
    ["retry", { ...completedOutcome, willRetry: true }, false],
    ["aborted", { status: "aborted" }, false],
    ["skipped", { status: "skipped", reason: "Nothing to compact (session too small)" }, false],
    ["failed", { status: "failed", reason: "Summary generation failed" }, false],
  ] as const)(
    "settles %s compaction without starting ineligible hooks",
    async (_name, outcome, terminalAborted) => {
      hookMocks.runner.hasHooks.mockReturnValue(true);
      const completed = outcome.status === "completed";
      const retry = completed && outcome.willRetry;
      const usageMessage = assistant(184_297, 130_000, 2_000);
      const ctx = createCompactionEndCtx({
        runId: "end",
        messages: retry ? [usageMessage] : completed ? [1, 2] : [],
        sessionFile: "/tmp/session.jsonl",
        sessionKey: "agent:main:web-xyz",
        compactionCount: completed ? 1 : 0,
        withRetryHooks: retry,
        isTerminalAborted: () => terminalAborted,
      });
      await runCompactionEnd(ctx, outcome);
      expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(completed ? 1 : 0);
      if (completed) {
        expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(50);
      } else {
        expect(ctx.noteCompactionTokensAfter).not.toHaveBeenCalled();
      }
      expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(retry ? 0 : 1);
      expectEndEvent("end", outcome.status, retry);
      const runHook = completed && !retry && !terminalAborted;
      expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(runHook ? 1 : 0);
      if (runHook) {
        expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledWith(
          { messageCount: 2, compactedCount: 1, sessionFile: "/tmp/session.jsonl" },
          { sessionKey: "agent:main:web-xyz" },
        );
      }
      if (retry) {
        expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
        expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
        expect(usageMessage.usage).toEqual({ totalTokens: 184_297, input: 130_000, output: 2_000 });
      }
    },
  );

  it("retains queued compaction facts without starting hooks after unsubscribe", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const flushStarted = createDeferred();
    const flush = createDeferred();
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-compaction-hook-after-unsubscribe",
      sessionExtras: { messages: [] },
      blockReplyBreak: "message_end",
      onBlockReplyFlush: () => {
        flushStarted.resolve();
        return flush.promise;
      },
      onAgentEvent,
    });
    try {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Previous reply" }],
          stopReason: "stop",
        },
      });
      await flushStarted.promise;
      emit({
        type: "compaction_end",
        reason: "threshold",
        outcome: completedOutcome,
      });
      expect(subscription.getCompactionCount()).toBe(0);
      expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();

      // The end event is already queued behind delivery when teardown closes the subscription.
      subscription.unsubscribe();
      flush.resolve();
      await subscription.waitForPendingEvents();

      expect(subscription.getCompactionCount()).toBe(1);
      expect(subscription.getLastCompactionTokensAfter()).toBe(50);
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "compaction",
        data: { phase: "end", outcome: "completed", completed: true, willRetry: false },
      });
      expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
    } finally {
      flush.resolve();
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
    }
  });

  it("resets stale assistant usage after final compaction", async () => {
    const assistants = [assistant(180_000, 100, 50), assistant(181_000, 120, 60)];
    const messages = [{ role: "user", content: "hello" }, ...assistants];
    await runCompactionEnd(createCompactionEndCtx({ runId: "r4", messages, compactionCount: 1 }));
    expect(
      messages.slice(1).map((message) => ("usage" in message ? message.usage : undefined)),
    ).toEqual([makeZeroUsageSnapshot(), makeZeroUsageSnapshot()]);
  });
});
