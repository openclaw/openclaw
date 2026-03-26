import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMemoryPluginState,
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  resolveMemoryFlushPlan,
  restoreMemoryPluginState,
} from "./memory-state.js";

describe("memory plugin state", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("returns empty defaults when no memory plugin state is registered", () => {
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([]);
  });

  it("delegates prompt building to the registered memory plugin", () => {
    registerMemoryPromptSection(({ availableTools }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return ["## Custom Memory", "Use custom memory tools.", ""];
    });

    expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([
      "## Custom Memory",
      "Use custom memory tools.",
      "",
    ]);
  });

  it("passes citations mode through to the prompt builder", () => {
    registerMemoryPromptSection(({ citationsMode }) => [
      `citations: ${citationsMode ?? "default"}`,
    ]);

    expect(
      buildMemoryPromptSection({
        availableTools: new Set(),
        citationsMode: "off",
      }),
    ).toEqual(["citations: off"]);
  });

  it("uses the registered flush plan resolver", () => {
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "prompt",
      systemPrompt: "system",
      relativePath: "memory/test.md",
    }));

    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/test.md");
  });

  it("restoreMemoryPluginState swaps both prompt and flush state", () => {
    registerMemoryPromptSection(() => ["first"]);
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "first",
      systemPrompt: "first",
      relativePath: "memory/first.md",
    }));
    const snapshot = {
      promptBuilder: getMemoryPromptSectionBuilder(),
      flushPlanResolver: getMemoryFlushPlanResolver(),
    };

    _resetMemoryPluginState();
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["first"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
  });

  it("clearMemoryPluginState resets both registries", () => {
    registerMemoryPromptSection(() => ["stale section"]);
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "prompt",
      systemPrompt: "system",
      relativePath: "memory/stale.md",
    }));

    clearMemoryPluginState();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
  });
});
