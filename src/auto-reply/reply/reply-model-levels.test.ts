import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ThinkLevel } from "../thinking.js";
import { createReplyModelLevelResolver } from "./reply-model-levels.js";

const selection = {
  provider: "openai",
  model: "test-model",
  thinkingExplicit: false,
  reasoningLevel: "off" as const,
  reasoningExplicit: false,
};

describe("reply model level cancellation", () => {
  it.each(["thinking", "reasoning"] as const)(
    "releases an aborted %s waiter without cancelling shared discovery",
    async (stage) => {
      const catalog = createDeferred<"off">();
      const started = createDeferred();
      const resolveDefaultThinkingLevel = vi.fn(() => {
        if (stage === "thinking") {
          started.resolve();
          return catalog.promise;
        }
        return Promise.resolve("off" as const);
      });
      const resolveDefaultReasoningLevel = vi.fn(() => {
        started.resolve();
        return catalog.promise;
      });
      const modelState = { resolveDefaultThinkingLevel, resolveDefaultReasoningLevel };
      const controller = new AbortController();
      const resolver = createReplyModelLevelResolver({
        selection,
        modelState,
        abortSignal: controller.signal,
      });
      const survivorResolver = createReplyModelLevelResolver({ selection, modelState });
      const continueReply = vi.fn();
      const abortedReply = resolver().then(continueReply);
      await started.promise;
      const survivor = survivorResolver();
      const reason = new Error("reply deadline");
      controller.abort(reason);
      await expect(abortedReply).rejects.toMatchObject({ name: "AbortError", cause: reason });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      catalog.resolve("off");
      await expect(survivor).resolves.toEqual({
        resolvedThinkLevel: "off",
        resolvedReasoningLevel: "off",
      });
      expect(continueReply).not.toHaveBeenCalled();
      expect(resolveDefaultReasoningLevel).toHaveBeenCalledTimes(stage === "thinking" ? 1 : 2);
    },
  );

  it.each([false, true])(
    "rejects aborted reads without starting discovery (cached=%s)",
    async (cached) => {
      const controller = new AbortController();
      const modelState = {
        resolveDefaultThinkingLevel: vi.fn(async (): Promise<ThinkLevel> =>
          cached ? "low" : "off",
        ),
        resolveDefaultReasoningLevel: vi.fn(async () =>
          cached ? ("off" as const) : ("on" as const),
        ),
      };
      if (!cached) {
        controller.abort();
      }
      const resolver = createReplyModelLevelResolver({
        selection,
        modelState,
        abortSignal: controller.signal,
      });
      if (cached) {
        await expect(resolver()).resolves.toEqual({
          resolvedThinkLevel: "low",
          resolvedReasoningLevel: "off",
        });
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        controller.abort();
      }
      await expect(resolver()).rejects.toMatchObject({ name: "AbortError" });
      expect(modelState.resolveDefaultThinkingLevel).toHaveBeenCalledTimes(cached ? 1 : 0);
      expect(modelState.resolveDefaultReasoningLevel).not.toHaveBeenCalled();
    },
  );
});
