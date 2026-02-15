import { describe, it, expect, beforeEach } from "vitest";
import {
  createExecCompletionEvent,
  isExecCompletionEvent,
  createInternalHookEvent,
  registerInternalHook,
  unregisterInternalHook,
  clearInternalHooks,
  triggerInternalHook,
} from "./internal-hooks.js";
import type { ExecCompletionHookContext, InternalHookEvent } from "./internal-hooks.js";

describe("exec completion hook events", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  it("creates a completed event with correct shape", () => {
    const ctx: ExecCompletionHookContext = {
      sessionId: "abc-123",
      slug: "test-slug",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      durationMs: 1500,
      tailOutput: "hello world",
      backgrounded: true,
    };
    const event = createExecCompletionEvent("completed", "agent:main:main", ctx);

    expect(event.type).toBe("exec");
    expect(event.action).toBe("completed");
    expect(event.sessionKey).toBe("agent:main:main");
    expect(event.context.exitCode).toBe(0);
    expect(event.context.sessionId).toBe("abc-123");
    expect(event.context.tailOutput).toBe("hello world");
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.messages).toEqual([]);
  });

  it("creates a failed event for signal kill", () => {
    const event = createExecCompletionEvent("failed", "agent:main:main", {
      sessionId: "def-456",
      exitCode: null,
      exitSignal: "SIGKILL",
      timedOut: false,
      durationMs: 30000,
      tailOutput: "",
      backgrounded: false,
    });

    expect(event.type).toBe("exec");
    expect(event.action).toBe("failed");
    expect(event.context.exitSignal).toBe("SIGKILL");
    expect(event.context.exitCode).toBeNull();
  });

  it("creates a failed event for timeout", () => {
    const event = createExecCompletionEvent("failed", "agent:main:main", {
      sessionId: "ghi-789",
      exitCode: null,
      exitSignal: "SIGKILL",
      timedOut: true,
      durationMs: 60000,
      tailOutput: "partial output",
      backgrounded: true,
    });

    expect(event.context.timedOut).toBe(true);
  });

  it("includes nodeId for remote exec", () => {
    const event = createExecCompletionEvent("completed", "agent:main:main", {
      sessionId: "node-run-1",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      durationMs: 5000,
      tailOutput: "done",
      backgrounded: false,
      nodeId: "gruntnode1",
    });

    expect(event.context.nodeId).toBe("gruntnode1");
  });

  it("isExecCompletionEvent returns true for exec events", () => {
    const execEvent = createExecCompletionEvent("completed", "test", {
      sessionId: "s1",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      durationMs: 100,
      tailOutput: "",
      backgrounded: false,
    });
    expect(isExecCompletionEvent(execEvent)).toBe(true);
  });

  it("isExecCompletionEvent returns false for non-exec events", () => {
    const commandEvent = createInternalHookEvent("command", "new", "test");
    expect(isExecCompletionEvent(commandEvent)).toBe(false);
  });

  it("triggers exec:completed handlers", async () => {
    const captured: InternalHookEvent[] = [];
    const handler = (event: InternalHookEvent) => {
      captured.push(event);
    };

    registerInternalHook("exec:completed", handler);

    const event = createExecCompletionEvent("completed", "agent:main:main", {
      sessionId: "trigger-test",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      durationMs: 200,
      tailOutput: "success",
      backgrounded: true,
    });

    await triggerInternalHook(event);

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("exec");
    expect(captured[0].action).toBe("completed");

    unregisterInternalHook("exec:completed", handler);
  });

  it("triggers exec:failed handlers", async () => {
    const captured: InternalHookEvent[] = [];
    registerInternalHook("exec:failed", (event) => {
      captured.push(event);
    });

    const event = createExecCompletionEvent("failed", "agent:main:main", {
      sessionId: "fail-test",
      exitCode: 1,
      exitSignal: null,
      timedOut: false,
      durationMs: 500,
      tailOutput: "error occurred",
      backgrounded: false,
    });

    await triggerInternalHook(event);

    expect(captured).toHaveLength(1);
    expect(captured[0].action).toBe("failed");
  });

  it("triggers general exec handler for both completed and failed", async () => {
    const captured: InternalHookEvent[] = [];
    registerInternalHook("exec", (event) => {
      captured.push(event);
    });

    const completedEvent = createExecCompletionEvent("completed", "test", {
      sessionId: "s1",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      durationMs: 100,
      tailOutput: "",
      backgrounded: false,
    });

    const failedEvent = createExecCompletionEvent("failed", "test", {
      sessionId: "s2",
      exitCode: 1,
      exitSignal: null,
      timedOut: false,
      durationMs: 100,
      tailOutput: "",
      backgrounded: false,
    });

    await triggerInternalHook(completedEvent);
    await triggerInternalHook(failedEvent);

    expect(captured).toHaveLength(2);
    expect(captured[0].action).toBe("completed");
    expect(captured[1].action).toBe("failed");
  });

  it("handler errors do not prevent other handlers from running", async () => {
    const captured: string[] = [];

    registerInternalHook("exec:completed", () => {
      throw new Error("handler 1 fails");
    });
    registerInternalHook("exec:completed", () => {
      captured.push("handler 2 ran");
    });

    const event = createExecCompletionEvent("completed", "test", {
      sessionId: "err-test",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      durationMs: 100,
      tailOutput: "",
      backgrounded: false,
    });

    // Should not throw
    await triggerInternalHook(event);
    expect(captured).toEqual(["handler 2 ran"]);
  });
});
