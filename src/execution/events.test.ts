import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExecutionEvent } from "./types.js";
import {
  EventRouter,
  createEventRouter,
  createLegacyEventAdapter,
  createEvent,
  createLifecycleStartEvent,
  createLifecycleEndEvent,
  createLifecycleErrorEvent,
  createToolStartEvent,
  createToolEndEvent,
  createAssistantPartialEvent,
  createAssistantCompleteEvent,
  createCompactionStartEvent,
  createCompactionEndEvent,
  createHookTriggeredEvent,
  getHookForEventKind,
  EVENT_TO_HOOK_MAP,
} from "./events.js";

describe("EventRouter", () => {
  let router: EventRouter;

  beforeEach(() => {
    router = new EventRouter();
  });

  describe("subscription", () => {
    it("should subscribe and receive events", async () => {
      const received: ExecutionEvent[] = [];
      router.subscribe((event) => {
        received.push(event);
      });

      const event = createLifecycleStartEvent("run-1", { prompt: "hello" });
      await router.emit(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(event);
    });

    it("should support multiple subscribers", async () => {
      const received1: ExecutionEvent[] = [];
      const received2: ExecutionEvent[] = [];

      router.subscribe((event) => {
        received1.push(event);
      });
      router.subscribe((event) => {
        received2.push(event);
      });

      const event = createLifecycleStartEvent("run-1", { prompt: "hello" });
      await router.emit(event);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    it("should unsubscribe correctly", async () => {
      const received: ExecutionEvent[] = [];
      const unsubscribe = router.subscribe((event) => {
        received.push(event);
      });

      const event1 = createLifecycleStartEvent("run-1", { prompt: "hello" });
      await router.emit(event1);
      expect(received).toHaveLength(1);

      unsubscribe();

      const event2 = createLifecycleEndEvent("run-1", { success: true });
      await router.emit(event2);
      expect(received).toHaveLength(1); // Still 1, not 2
    });

    it("should track listener count", () => {
      expect(router.getListenerCount()).toBe(0);

      const unsub1 = router.subscribe(() => {});
      expect(router.getListenerCount()).toBe(1);

      const unsub2 = router.subscribe(() => {});
      expect(router.getListenerCount()).toBe(2);

      unsub1();
      expect(router.getListenerCount()).toBe(1);

      unsub2();
      expect(router.getListenerCount()).toBe(0);
    });
  });

  describe("async listeners", () => {
    it("should await async listeners", async () => {
      const order: string[] = [];

      router.subscribe(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("async-1");
      });

      router.subscribe(() => {
        order.push("sync-2");
      });

      router.subscribe(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("async-3");
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));

      // All listeners should have completed, in order
      expect(order).toEqual(["async-1", "sync-2", "async-3"]);
    });

    it("should handle mixed sync and async listeners", async () => {
      const results: number[] = [];

      router.subscribe(() => {
        results.push(1);
      });
      router.subscribe(async () => {
        await Promise.resolve();
        results.push(2);
      });
      router.subscribe(() => {
        results.push(3);
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));

      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe("error handling", () => {
    it("should catch and log sync listener errors", async () => {
      const errorLogs: string[] = [];
      const logger = {
        error: (msg: string) => {
          errorLogs.push(msg);
        },
      };

      router = new EventRouter({ logger });

      const received: ExecutionEvent[] = [];
      router.subscribe(() => {
        throw new Error("Sync error");
      });
      router.subscribe((event) => {
        received.push(event);
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));

      // First listener threw, but second still received the event
      expect(received).toHaveLength(1);
      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0]).toContain("Sync error");
    });

    it("should catch and log async listener errors", async () => {
      const errorLogs: string[] = [];
      const logger = {
        error: (msg: string) => {
          errorLogs.push(msg);
        },
      };

      router = new EventRouter({ logger });

      const received: ExecutionEvent[] = [];
      router.subscribe(async () => {
        await Promise.resolve();
        throw new Error("Async error");
      });
      router.subscribe((event) => {
        received.push(event);
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));

      expect(received).toHaveLength(1);
      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0]).toContain("Async error");
    });

    it("should continue processing after errors", async () => {
      const received: ExecutionEvent[] = [];

      router.subscribe(() => {
        throw new Error("Error 1");
      });
      router.subscribe((event) => {
        received.push(event);
      });
      router.subscribe(() => {
        throw new Error("Error 2");
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));

      // Middle listener should still receive event
      expect(received).toHaveLength(1);
    });
  });

  describe("emitSync", () => {
    it("should emit synchronously without awaiting async listeners", () => {
      let asyncCompleted = false;
      const syncResults: string[] = [];

      router.subscribe(() => {
        syncResults.push("sync-1");
      });
      router.subscribe(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        asyncCompleted = true;
      });
      router.subscribe(() => {
        syncResults.push("sync-2");
      });

      router.emitSync(createLifecycleStartEvent("run-1", { prompt: "test" }));

      // Sync listeners completed immediately
      expect(syncResults).toEqual(["sync-1", "sync-2"]);
      // Async not yet completed
      expect(asyncCompleted).toBe(false);
    });

    it("should handle async errors gracefully in emitSync", async () => {
      const errorLogs: string[] = [];
      const logger = {
        error: (msg: string) => {
          errorLogs.push(msg);
        },
      };

      router = new EventRouter({ logger });

      router.subscribe(async () => {
        throw new Error("Async error in emitSync");
      });

      router.emitSync(createLifecycleStartEvent("run-1", { prompt: "test" }));

      // Wait for async listener to complete and error
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0]).toContain("Async error in emitSync");
    });
  });

  describe("runId filtering", () => {
    it("should filter events by runId when configured", async () => {
      router = new EventRouter({ runIdFilter: "run-1" });

      const received: ExecutionEvent[] = [];
      router.subscribe((event) => {
        received.push(event);
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "included" }));
      await router.emit(createLifecycleStartEvent("run-2", { prompt: "excluded" }));
      await router.emit(createLifecycleEndEvent("run-1", { success: true }));

      expect(received).toHaveLength(2);
      expect(received[0].runId).toBe("run-1");
      expect(received[1].runId).toBe("run-1");
    });

    it("should not filter when runIdFilter is not set", async () => {
      const received: ExecutionEvent[] = [];
      router.subscribe((event) => {
        received.push(event);
      });

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "a" }));
      await router.emit(createLifecycleStartEvent("run-2", { prompt: "b" }));

      expect(received).toHaveLength(2);
    });
  });

  describe("getEmittedEvents", () => {
    it("should store and return all emitted events", async () => {
      const event1 = createLifecycleStartEvent("run-1", { prompt: "test" });
      const event2 = createToolStartEvent("run-1", { toolName: "bash", toolCallId: "tc-1" });
      const event3 = createLifecycleEndEvent("run-1", { success: true });

      await router.emit(event1);
      await router.emit(event2);
      await router.emit(event3);

      const events = router.getEmittedEvents();
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
      expect(events[2]).toEqual(event3);
    });

    it("should return a copy of events array", async () => {
      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));

      const events1 = router.getEmittedEvents();
      const events2 = router.getEmittedEvents();

      expect(events1).not.toBe(events2);
      expect(events1).toEqual(events2);
    });
  });

  describe("clear", () => {
    it("should remove all listeners", async () => {
      const received: ExecutionEvent[] = [];
      router.subscribe((event) => {
        received.push(event);
      });
      router.subscribe((event) => {
        received.push(event);
      });

      expect(router.getListenerCount()).toBe(2);

      router.clear();

      expect(router.getListenerCount()).toBe(0);

      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));
      expect(received).toHaveLength(0);
    });

    it("should clear emitted events", async () => {
      await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));
      expect(router.getEmittedEvents()).toHaveLength(1);

      router.clear();

      expect(router.getEmittedEvents()).toHaveLength(0);
    });
  });
});

describe("createEventRouter", () => {
  it("should create router with options", () => {
    const router = createEventRouter({ runIdFilter: "run-1" });
    expect(router).toBeInstanceOf(EventRouter);
  });

  it("should wire up legacy event system when provided", async () => {
    const legacyEvents: Array<{
      runId: string;
      stream: string;
      data: Record<string, unknown>;
    }> = [];

    const legacyEmit = vi.fn((event) => legacyEvents.push(event));
    const router = createEventRouter({}, legacyEmit);

    await router.emit(createLifecycleStartEvent("run-1", { prompt: "test" }));
    await router.emit(createToolStartEvent("run-1", { toolName: "bash", toolCallId: "tc-1" }));

    expect(legacyEmit).toHaveBeenCalledTimes(2);
    expect(legacyEvents[0].runId).toBe("run-1");
    expect(legacyEvents[0].stream).toBe("lifecycle");
    expect(legacyEvents[1].stream).toBe("tool");
  });
});

describe("createLegacyEventAdapter", () => {
  it("should map lifecycle events to lifecycle stream", () => {
    const emitted: Array<{ runId: string; stream: string; data: Record<string, unknown> }> = [];
    const adapter = createLegacyEventAdapter((event) => emitted.push(event));

    void adapter(createLifecycleStartEvent("run-1", { prompt: "test" }));
    void adapter(createLifecycleEndEvent("run-1", { success: true }));
    void adapter(createLifecycleErrorEvent("run-1", { error: "fail" }));

    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => e.stream === "lifecycle")).toBe(true);
  });

  it("should map tool events to tool stream", () => {
    const emitted: Array<{ runId: string; stream: string; data: Record<string, unknown> }> = [];
    const adapter = createLegacyEventAdapter((event) => emitted.push(event));

    void adapter(createToolStartEvent("run-1", { toolName: "bash", toolCallId: "tc-1" }));
    void adapter(
      createToolEndEvent("run-1", { toolName: "bash", toolCallId: "tc-1", success: true }),
    );

    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.stream === "tool")).toBe(true);
  });

  it("should map assistant events to assistant stream", () => {
    const emitted: Array<{ runId: string; stream: string; data: Record<string, unknown> }> = [];
    const adapter = createLegacyEventAdapter((event) => emitted.push(event));

    void adapter(createAssistantPartialEvent("run-1", { text: "partial" }));
    void adapter(createAssistantCompleteEvent("run-1", { text: "complete" }));

    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.stream === "assistant")).toBe(true);
  });

  it("should preserve sessionKey in data", () => {
    const emitted: Array<{
      runId: string;
      stream: string;
      data: Record<string, unknown>;
      sessionKey?: string;
    }> = [];
    const adapter = createLegacyEventAdapter((event) => emitted.push(event));

    void adapter(
      createLifecycleStartEvent("run-1", {
        prompt: "test",
        sessionKey: "sess-123",
      }),
    );

    expect(emitted[0].sessionKey).toBe("sess-123");
  });
});

describe("hook mapping", () => {
  describe("EVENT_TO_HOOK_MAP", () => {
    it("should map lifecycle.start to before_agent_start", () => {
      expect(EVENT_TO_HOOK_MAP["lifecycle.start"]).toBe("before_agent_start");
    });

    it("should map lifecycle.end to agent_end", () => {
      expect(EVENT_TO_HOOK_MAP["lifecycle.end"]).toBe("agent_end");
    });

    it("should map tool.start to before_tool_call", () => {
      expect(EVENT_TO_HOOK_MAP["tool.start"]).toBe("before_tool_call");
    });

    it("should map tool.end to after_tool_call", () => {
      expect(EVENT_TO_HOOK_MAP["tool.end"]).toBe("after_tool_call");
    });

    it("should map compaction.start to before_compaction", () => {
      expect(EVENT_TO_HOOK_MAP["compaction.start"]).toBe("before_compaction");
    });

    it("should map compaction.end to after_compaction", () => {
      expect(EVENT_TO_HOOK_MAP["compaction.end"]).toBe("after_compaction");
    });

    it("should not map assistant events to hooks", () => {
      expect(EVENT_TO_HOOK_MAP["assistant.partial"]).toBeUndefined();
      expect(EVENT_TO_HOOK_MAP["assistant.complete"]).toBeUndefined();
    });

    it("should not map lifecycle.error to a hook", () => {
      expect(EVENT_TO_HOOK_MAP["lifecycle.error"]).toBeUndefined();
    });
  });

  describe("getHookForEventKind", () => {
    it("should return hook name for mapped events", () => {
      expect(getHookForEventKind("lifecycle.start")).toBe("before_agent_start");
      expect(getHookForEventKind("tool.end")).toBe("after_tool_call");
    });

    it("should return undefined for unmapped events", () => {
      expect(getHookForEventKind("assistant.partial")).toBeUndefined();
      expect(getHookForEventKind("hook.triggered")).toBeUndefined();
    });
  });
});

describe("event builder helpers", () => {
  describe("createEvent", () => {
    it("should create event with timestamp", () => {
      const before = Date.now();
      const event = createEvent("lifecycle.start", "run-1", { prompt: "test" });
      const after = Date.now();

      expect(event.kind).toBe("lifecycle.start");
      expect(event.runId).toBe("run-1");
      expect(event.data).toEqual({ prompt: "test" });
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it("should use empty data when not provided", () => {
      const event = createEvent("lifecycle.end", "run-1");
      expect(event.data).toEqual({});
    });
  });

  describe("lifecycle events", () => {
    it("should create lifecycle.start event", () => {
      const event = createLifecycleStartEvent("run-1", {
        prompt: "hello",
        agentId: "agent-1",
        sessionKey: "sess-1",
      });

      expect(event.kind).toBe("lifecycle.start");
      expect(event.data).toEqual({
        prompt: "hello",
        agentId: "agent-1",
        sessionKey: "sess-1",
      });
    });

    it("should create lifecycle.end event", () => {
      const event = createLifecycleEndEvent("run-1", {
        success: true,
        durationMs: 1500,
      });

      expect(event.kind).toBe("lifecycle.end");
      expect(event.data).toEqual({
        success: true,
        durationMs: 1500,
      });
    });

    it("should create lifecycle.error event", () => {
      const event = createLifecycleErrorEvent("run-1", {
        error: "Something went wrong",
        kind: "runtime_error",
        retryable: true,
      });

      expect(event.kind).toBe("lifecycle.error");
      expect(event.data).toEqual({
        error: "Something went wrong",
        kind: "runtime_error",
        retryable: true,
      });
    });
  });

  describe("tool events", () => {
    it("should create tool.start event", () => {
      const event = createToolStartEvent("run-1", {
        toolName: "bash",
        toolCallId: "tc-123",
        params: { command: "ls -la" },
      });

      expect(event.kind).toBe("tool.start");
      expect(event.data).toEqual({
        toolName: "bash",
        toolCallId: "tc-123",
        params: { command: "ls -la" },
      });
    });

    it("should create tool.end event", () => {
      const event = createToolEndEvent("run-1", {
        toolName: "bash",
        toolCallId: "tc-123",
        success: true,
        result: "file1.txt\nfile2.txt",
        durationMs: 100,
      });

      expect(event.kind).toBe("tool.end");
      expect(event.data).toEqual({
        toolName: "bash",
        toolCallId: "tc-123",
        success: true,
        result: "file1.txt\nfile2.txt",
        durationMs: 100,
      });
    });

    it("should create tool.end event with error", () => {
      const event = createToolEndEvent("run-1", {
        toolName: "bash",
        toolCallId: "tc-123",
        success: false,
        error: "Command not found",
      });

      expect(event.kind).toBe("tool.end");
      expect(event.data.success).toBe(false);
      expect(event.data.error).toBe("Command not found");
    });
  });

  describe("assistant events", () => {
    it("should create assistant.partial event", () => {
      const event = createAssistantPartialEvent("run-1", { text: "Hello, " });

      expect(event.kind).toBe("assistant.partial");
      expect(event.data).toEqual({ text: "Hello, " });
    });

    it("should create assistant.complete event", () => {
      const event = createAssistantCompleteEvent("run-1", {
        text: "Hello, world!",
        toolCalls: 2,
      });

      expect(event.kind).toBe("assistant.complete");
      expect(event.data).toEqual({
        text: "Hello, world!",
        toolCalls: 2,
      });
    });
  });

  describe("compaction events", () => {
    it("should create compaction.start event", () => {
      const event = createCompactionStartEvent("run-1", {
        messageCount: 100,
        tokenCount: 50000,
      });

      expect(event.kind).toBe("compaction.start");
      expect(event.data).toEqual({
        messageCount: 100,
        tokenCount: 50000,
      });
    });

    it("should create compaction.end event", () => {
      const event = createCompactionEndEvent("run-1", {
        messageCount: 20,
        compactedCount: 80,
        tokenCount: 10000,
      });

      expect(event.kind).toBe("compaction.end");
      expect(event.data).toEqual({
        messageCount: 20,
        compactedCount: 80,
        tokenCount: 10000,
      });
    });
  });

  describe("hook events", () => {
    it("should create hook.triggered event", () => {
      const event = createHookTriggeredEvent("run-1", {
        hookName: "before_agent_start",
        pluginId: "my-plugin",
      });

      expect(event.kind).toBe("hook.triggered");
      expect(event.data).toEqual({
        hookName: "before_agent_start",
        pluginId: "my-plugin",
      });
    });
  });
});
