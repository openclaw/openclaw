import { afterEach, describe, expect, it } from "vitest";

import { emitQueueCompletion, emitRunCompletion, emitTurnCompletion } from "./emit.js";
import { clearCompletionHandlers, onCompletion } from "./registry.js";
import type { CompletionEvent } from "./types.js";

describe("continuation/emit", () => {
  afterEach(() => {
    clearCompletionHandlers();
  });

  describe("emitTurnCompletion", () => {
    it("emits turn-level event with correct structure", async () => {
      const receivedEvents: CompletionEvent[] = [];
      onCompletion((event) => {
        receivedEvents.push(event);
      });

      emitTurnCompletion({
        runId: "run-123",
        sessionId: "sess-456",
        sessionKey: "agent-1:+1234567890",
        assistantTexts: ["Hello", "World"],
        toolMetas: [{ toolName: "bash", meta: "ls -la" }],
        didSendViaMessagingTool: true,
        lastToolError: { toolName: "exec", error: "Permission denied" },
      });

      // Give async processing time to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].level).toBe("turn");

      const event = receivedEvents[0];
      if (event.level !== "turn") throw new Error("Expected turn event");

      expect(event.runId).toBe("run-123");
      expect(event.sessionId).toBe("sess-456");
      expect(event.sessionKey).toBe("agent-1:+1234567890");
      expect(event.assistantTexts).toEqual(["Hello", "World"]);
      expect(event.toolMetas).toEqual([{ toolName: "bash", meta: "ls -la" }]);
      expect(event.didSendViaMessagingTool).toBe(true);
      expect(event.lastToolError).toEqual({ toolName: "exec", error: "Permission denied" });
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("is fire-and-forget (does not block)", () => {
      let handlerCalled = false;
      onCompletion(async () => {
        await new Promise((r) => setTimeout(r, 100));
        handlerCalled = true;
      });

      // This should return immediately without waiting
      emitTurnCompletion({
        runId: "run-1",
        sessionId: "sess-1",
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      });

      // Handler hasn't been called yet since we didn't await
      expect(handlerCalled).toBe(false);
    });
  });

  describe("emitRunCompletion", () => {
    it("emits run-level event and returns decision", async () => {
      onCompletion((event) => {
        if (event.level === "run") {
          return {
            action: "enqueue" as const,
            nextPrompt: "Continue the task",
          };
        }
      });

      const decision = await emitRunCompletion({
        runId: "run-789",
        sessionId: "sess-abc",
        sessionKey: "agent-2:group-chat",
        queueKey: "agent-2:+9876543210",
        payloads: [{ text: "Response text" }],
        autoCompactionCompleted: false,
        model: "claude-sonnet-4",
        provider: "anthropic",
      });

      expect(decision.action).toBe("enqueue");
      expect(decision.nextPrompt).toBe("Continue the task");
    });

    it("returns none when no handler returns decision", async () => {
      onCompletion(() => undefined);

      const decision = await emitRunCompletion({
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "key-1",
        queueKey: "queue-1",
        payloads: [],
        autoCompactionCompleted: true,
        model: "gpt-4o",
        provider: "openai",
      });

      expect(decision.action).toBe("none");
    });
  });

  describe("emitQueueCompletion", () => {
    it("emits queue-level event with correct structure", async () => {
      const receivedEvents: CompletionEvent[] = [];
      onCompletion((event) => {
        receivedEvents.push(event);
        return { action: "none" as const };
      });

      const decision = await emitQueueCompletion({
        queueKey: "queue-xyz",
        sessionKey: "agent-3:sender",
        queueEmpty: true,
        itemsProcessed: 5,
        lastRun: {
          agentId: "agent-3",
          agentDir: "/path/to/agent",
          sessionId: "sess-final",
          sessionFile: "/path/to/session.jsonl",
          workspaceDir: "/workspace",
          config: {} as never,
          provider: "anthropic",
          model: "claude-sonnet-4",
          timeoutMs: 60000,
          blockReplyBreak: "text_end",
        },
      });

      expect(decision.action).toBe("none");
      expect(receivedEvents.length).toBe(1);

      const event = receivedEvents[0];
      if (event.level !== "queue") throw new Error("Expected queue event");

      expect(event.queueKey).toBe("queue-xyz");
      expect(event.sessionKey).toBe("agent-3:sender");
      expect(event.queueEmpty).toBe(true);
      expect(event.itemsProcessed).toBe(5);
      expect(event.lastRun?.sessionId).toBe("sess-final");
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("returns continuation decision when handler requests it", async () => {
      onCompletion((event) => {
        if (event.level === "queue" && event.queueEmpty) {
          return {
            action: "enqueue" as const,
            nextPrompt: "Queue emptied, checking for more work",
          };
        }
      });

      const decision = await emitQueueCompletion({
        queueKey: "queue-1",
        queueEmpty: true,
        itemsProcessed: 3,
      });

      expect(decision.action).toBe("enqueue");
      expect(decision.nextPrompt).toBe("Queue emptied, checking for more work");
    });
  });
});
