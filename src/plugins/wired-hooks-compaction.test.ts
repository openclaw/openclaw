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

  type Deferred = Promise<void> & { resolve: () => void };
  const createDeferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    }) as Deferred;
    promise.resolve = resolve;
    return promise;
  };

  it("calls runBeforeCompaction in handleAutoCompactionStart", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleAutoCompactionStart } =
      await import("../agents/pi-embedded-subscribe.handlers.compaction.js");

    const ctx = {
      params: {
        runId: "r1",
        session: { messages: [{ content: "before", nested: { count: 1 } }, { content: "after" }] },
      },
      state: { compactionInFlight: false },
      log: { debug: vi.fn(), warn: vi.fn() },
      incrementCompactionCount: vi.fn(),
      ensureCompactionPromise: vi.fn(),
    };

    const beforeGate = createDeferred();
    const eventSource: { messageCount: number; messages?: unknown[] } = { messageCount: 0 };
    hookMocks.runner.runBeforeCompaction.mockImplementation(
      async (event: { messages?: unknown[] }) => {
        eventSource.messageCount = event.messageCount;
        eventSource.messages = event.messages;
        await beforeGate;
      },
    );

    let startResolved = false;
    const startPromise = handleAutoCompactionStart(ctx as never).then(() => {
      startResolved = true;
    });

    await Promise.resolve();
    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(startResolved).toBe(false);

    const [event] = hookMocks.runner.runBeforeCompaction.mock.calls[0];
    expect(event.messageCount).toBe(2);
    expect(eventSource.messageCount).toBe(2);
    expect(eventSource.messages).not.toBe(ctx.params.session.messages as never);
    if (eventSource.messages?.[0] && typeof eventSource.messages[0] === "object") {
      const hookMessage = eventSource.messages[0] as {
        content?: string;
        nested?: { count?: number };
      };
      hookMessage.content = "changed-in-hook";
      if (hookMessage.nested) {
        hookMessage.nested.count = 9;
      }
    }
    expect((ctx.params.session.messages[0] as { content: string }).content).toBe("before");
    expect((ctx.params.session.messages[0] as { nested: { count: number } }).nested.count).toBe(1);

    beforeGate.resolve();
    await startPromise;
    expect(startResolved).toBe(true);
  });

  it("times out stuck before_compaction hooks in handleAutoCompactionStart", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const { COMPACTION_HOOK_TIMEOUT_MS, handleAutoCompactionStart } =
        await import("../agents/pi-embedded-subscribe.handlers.compaction.js");
      const warn = vi.fn();
      hookMocks.runner.runBeforeCompaction.mockImplementation(
        async () => new Promise<void>(() => {}),
      );

      const ctx = {
        params: { runId: "r-timeout", session: { messages: [{ content: "before" }] } },
        state: { compactionInFlight: false },
        log: { debug: vi.fn(), warn },
        incrementCompactionCount: vi.fn(),
        ensureCompactionPromise: vi.fn(),
      };

      const startPromise = handleAutoCompactionStart(ctx as never);
      await vi.advanceTimersByTimeAsync(COMPACTION_HOOK_TIMEOUT_MS + 1);
      await startPromise;

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `before_compaction hook timed out after ${COMPACTION_HOOK_TIMEOUT_MS}ms`,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls runAfterCompaction when willRetry is false and awaits hook completion", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const { handleAutoCompactionEnd } =
      await import("../agents/pi-embedded-subscribe.handlers.compaction.js");

    const ctx = {
      params: {
        runId: "r2",
        session: { messages: [{ content: "before", nested: { count: 1 } }, { content: "after" }] },
      },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      getCompactionCount: () => 1,
    };

    const afterGate = createDeferred();
    const eventSource: { messageCount: number; compactedCount: number; messages?: unknown[] } = {
      messageCount: 0,
      compactedCount: 0,
    };
    hookMocks.runner.runAfterCompaction.mockImplementation(
      async (event: { messages?: unknown[] }) => {
        eventSource.messageCount = event.messageCount;
        eventSource.compactedCount = event.compactedCount;
        eventSource.messages = event.messages;
        await afterGate;
      },
    );

    let endResolved = false;
    const endPromise = handleAutoCompactionEnd(
      ctx as never,
      {
        type: "auto_compaction_end",
        willRetry: false,
      } as never,
    ).then(() => {
      endResolved = true;
    });

    await Promise.resolve();
    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(1);
    expect(endResolved).toBe(false);

    const [event] = hookMocks.runner.runAfterCompaction.mock.calls[0];
    expect(event.messageCount).toBe(2);
    expect(event.compactedCount).toBe(1);
    expect(eventSource.messageCount).toBe(2);
    expect(eventSource.compactedCount).toBe(1);
    expect(eventSource.messages).not.toBe(ctx.params.session.messages as never);
    if (eventSource.messages?.[0] && typeof eventSource.messages[0] === "object") {
      const hookMessage = eventSource.messages[0] as {
        content?: string;
        nested?: { count?: number };
      };
      hookMessage.content = "changed-after-hook";
      if (hookMessage.nested) {
        hookMessage.nested.count = 9;
      }
    }
    expect((ctx.params.session.messages[0] as { content: string }).content).toBe("before");
    expect((ctx.params.session.messages[0] as { nested: { count: number } }).nested.count).toBe(1);

    afterGate.resolve();
    await endPromise;
    expect(endResolved).toBe(true);
  });

  it("times out stuck after_compaction hooks in handleAutoCompactionEnd", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const { COMPACTION_HOOK_TIMEOUT_MS, handleAutoCompactionEnd } =
        await import("../agents/pi-embedded-subscribe.handlers.compaction.js");
      const warn = vi.fn();
      hookMocks.runner.runAfterCompaction.mockImplementation(
        async () => new Promise<void>(() => {}),
      );

      const ctx = {
        params: { runId: "r-timeout-end", session: { messages: [{ content: "before" }] } },
        state: { compactionInFlight: true },
        log: { debug: vi.fn(), warn },
        maybeResolveCompactionWait: vi.fn(),
        getCompactionCount: () => 1,
      };

      const endPromise = handleAutoCompactionEnd(
        ctx as never,
        {
          type: "auto_compaction_end",
          willRetry: false,
        } as never,
      );
      await vi.advanceTimersByTimeAsync(COMPACTION_HOOK_TIMEOUT_MS + 1);
      await endPromise;

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `after_compaction hook timed out after ${COMPACTION_HOOK_TIMEOUT_MS}ms`,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
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

    await handleAutoCompactionEnd(
      ctx as never,
      {
        type: "auto_compaction_end",
        willRetry: true,
      } as never,
    );
    expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
  });
});
