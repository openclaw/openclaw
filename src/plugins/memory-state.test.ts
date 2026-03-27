import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMemoryPluginState,
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  getMemoryRuntime,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryRuntime,
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
    expect(getMemoryRuntime()).toBeUndefined();
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

  it("stores the registered memory runtime", async () => {
    const runtime = {
      async getMemorySearchManager() {
        return { manager: null, error: "missing" };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    };

    registerMemoryRuntime(runtime);

    expect(getMemoryRuntime()).toBe(runtime);
    await expect(
      getMemoryRuntime()?.getMemorySearchManager({
        cfg: {} as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "missing" });
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
    const runtime = {
      async getMemorySearchManager() {
        return { manager: null, error: "missing" };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    };
    registerMemoryRuntime(runtime);
    const snapshot = {
      promptBuilder: getMemoryPromptSectionBuilder(),
      flushPlanResolver: getMemoryFlushPlanResolver(),
      runtime: getMemoryRuntime(),
    };

    _resetMemoryPluginState();
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["first"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
    expect(getMemoryRuntime()).toBe(runtime);
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
    registerMemoryRuntime({
      async getMemorySearchManager() {
        return { manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    });

    clearMemoryPluginState();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
  });
});
