import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearCompletionHandlers,
  getHandlerCount,
  onCompletion,
  processCompletion,
} from "./registry.js";
import type { CompletionEvent, CompletionHandler } from "./types.js";

describe("continuation/registry", () => {
  afterEach(() => {
    clearCompletionHandlers();
  });

  describe("onCompletion", () => {
    it("registers a handler and returns unsubscribe function", () => {
      const handler: CompletionHandler = () => undefined;
      expect(getHandlerCount()).toBe(0);

      const unsubscribe = onCompletion(handler);
      expect(getHandlerCount()).toBe(1);

      unsubscribe();
      expect(getHandlerCount()).toBe(0);
    });

    it("supports custom id", () => {
      const handler: CompletionHandler = () => undefined;
      onCompletion(handler, { id: "my-handler" });
      expect(getHandlerCount()).toBe(1);
    });

    it("sorts handlers by priority (lower = first)", async () => {
      const calls: string[] = [];

      onCompletion(() => {
        calls.push("default");
      });
      onCompletion(
        () => {
          calls.push("low");
        },
        { priority: 50 },
      );
      onCompletion(
        () => {
          calls.push("high");
        },
        { priority: 150 },
      );

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      await processCompletion(event);
      expect(calls).toEqual(["low", "default", "high"]);
    });
  });

  describe("processCompletion", () => {
    it("returns { action: 'none' } when no handlers registered", async () => {
      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result).toEqual({ action: "none" });
    });

    it("returns { action: 'none' } when all handlers return void", async () => {
      onCompletion(() => undefined);
      onCompletion(() => undefined);

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result).toEqual({ action: "none" });
    });

    it("returns first non-none decision", async () => {
      onCompletion(() => ({ action: "none" as const }));
      onCompletion(() => ({
        action: "enqueue" as const,
        nextPrompt: "Continue",
        reason: "test",
      }));
      onCompletion(() => ({
        action: "immediate" as const,
        nextPrompt: "Now",
      }));

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result.action).toBe("enqueue");
      expect(result.nextPrompt).toBe("Continue");
    });

    it("filters handlers by level", async () => {
      const turnHandler = vi.fn(() => undefined);
      const runHandler = vi.fn(() => undefined);

      onCompletion(turnHandler, { levels: ["turn"] });
      onCompletion(runHandler, { levels: ["run"] });

      const turnEvent: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      await processCompletion(turnEvent);
      expect(turnHandler).toHaveBeenCalledTimes(1);
      expect(runHandler).toHaveBeenCalledTimes(0);
    });

    it("handles async handlers", async () => {
      onCompletion(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { action: "enqueue" as const, nextPrompt: "Async result" };
      });

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result.action).toBe("enqueue");
      expect(result.nextPrompt).toBe("Async result");
    });

    it("catches handler errors and continues", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      onCompletion(
        () => {
          throw new Error("Handler failed");
        },
        { id: "failing-handler", priority: 50 },
      );
      onCompletion(
        () => ({
          action: "enqueue" as const,
          nextPrompt: "Success",
        }),
        { priority: 100 },
      );

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result.action).toBe("enqueue");
      expect(errorSpy).toHaveBeenCalledWith(
        "Continuation handler failing-handler error:",
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it("adds default reason with handler id", async () => {
      onCompletion(
        () => ({
          action: "enqueue" as const,
          nextPrompt: "Test",
        }),
        { id: "my-test-handler" },
      );

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result.reason).toBe("decided by my-test-handler");
    });

    it("preserves explicit reason", async () => {
      onCompletion(() => ({
        action: "enqueue" as const,
        nextPrompt: "Test",
        reason: "My explicit reason",
      }));

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      expect(result.reason).toBe("My explicit reason");
    });
  });

  describe("clearCompletionHandlers", () => {
    it("removes all handlers", () => {
      onCompletion(() => undefined);
      onCompletion(() => undefined);
      onCompletion(() => undefined);

      expect(getHandlerCount()).toBe(3);
      clearCompletionHandlers();
      expect(getHandlerCount()).toBe(0);
    });
  });
});
