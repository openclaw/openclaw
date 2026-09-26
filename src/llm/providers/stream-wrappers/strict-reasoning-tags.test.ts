// Strict reasoning-tag wrapper tests cover policy marking and option safety.
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createStrictReasoningTagsWrapper } from "./strict-reasoning-tags.js";

const context = { messages: [] } as Context;

function makeModel(id: string, api = "openai-completions"): Model<"openai-completions"> {
  return { api, provider: "xiaomi-coding", id } as Model<"openai-completions">;
}

function isMiMoStrictModel(model: Parameters<StreamFn>[0]): boolean {
  return model.api === "openai-completions" && model.id === "mimo-v2.6-pro";
}

describe("createStrictReasoningTagsWrapper", () => {
  it("marks strict-on-flush reasoning-tag policy for matching models", () => {
    let capturedOptions: Parameters<StreamFn>[2];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions = options;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createStrictReasoningTagsWrapper({
      baseStreamFn,
      shouldMarkStrictOnFlush: isMiMoStrictModel,
    });

    void wrapped?.(makeModel("mimo-v2.6-pro"), context, {});

    // The stream wrapper selects the stream-safe level: interactive chat must
    // keep streaming visible text instead of buffering until flush.
    expect(reasoningTagTextPolicy.isStrictOnFlush(capturedOptions)).toBe(true);
    expect(reasoningTagTextPolicy.isStrict(capturedOptions)).toBe(false);
  });

  it("passes options through unmarked for non-matching models", () => {
    let capturedOptions: Parameters<StreamFn>[2];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions = options;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createStrictReasoningTagsWrapper({
      baseStreamFn,
      shouldMarkStrictOnFlush: isMiMoStrictModel,
    });

    void wrapped?.(makeModel("mimo-v2-pro"), context, {});

    expect(reasoningTagTextPolicy.isStrict(capturedOptions)).toBe(false);
    expect(reasoningTagTextPolicy.isStrictOnFlush(capturedOptions)).toBe(false);
  });

  it("does not mutate the caller's options object", () => {
    const baseStreamFn: StreamFn = () => ({}) as ReturnType<StreamFn>;
    const wrapped = createStrictReasoningTagsWrapper({
      baseStreamFn,
      shouldMarkStrictOnFlush: isMiMoStrictModel,
    });
    const originalOptions = {};

    void wrapped?.(makeModel("mimo-v2.6-pro"), context, originalOptions);

    expect(reasoningTagTextPolicy.isStrict(originalOptions)).toBe(false);
    expect(reasoningTagTextPolicy.isStrictOnFlush(originalOptions)).toBe(false);
  });

  it("returns undefined when the base stream function is missing", () => {
    expect(
      createStrictReasoningTagsWrapper({
        baseStreamFn: undefined,
        shouldMarkStrictOnFlush: isMiMoStrictModel,
      }),
    ).toBeUndefined();
  });

  it("marks strict-on-flush for any predicate match, independent of provider naming", () => {
    let capturedOptions: Parameters<StreamFn>[2];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedOptions = options;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createStrictReasoningTagsWrapper({
      baseStreamFn,
      shouldMarkStrictOnFlush: (model) =>
        model.api === "openai-completions" && model.id === "custom-reasoner-1",
    });

    void wrapped?.(makeModel("custom-reasoner-1", "openai-completions"), context, {});

    expect(reasoningTagTextPolicy.isStrictOnFlush(capturedOptions)).toBe(true);
  });
});
