import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMemoryPluginState,
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  getMemoryRuntime,
  registerMemoryCapability,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
  restoreMemoryPluginState,
  listActiveMemoryPublicArtifacts,
} from "./memory-state.js";

function createMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { manager: null, error: "missing" };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

function createMemoryFlushPlan(relativePath: string) {
  return {
    softThresholdTokens: 1,
    forceFlushTranscriptBytes: 2,
    reserveTokensFloor: 3,
    prompt: relativePath,
    systemPrompt: relativePath,
    relativePath,
  };
}

function expectClearedMemoryState() {
  expect(resolveMemoryFlushPlan({})).toBeNull();
  expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([]);
  expect(getMemoryRuntime()).toBeUndefined();
  expect(getMemoryCapabilityRegistration()).toBeUndefined();
}

function createMemoryStateSnapshot() {
  return {
    capability: getMemoryCapabilityRegistration(),
    promptBuilder: getMemoryPromptSectionBuilder(),
    flushPlanResolver: getMemoryFlushPlanResolver(),
    runtime: getMemoryRuntime(),
  };
}

function registerMemoryState(params: {
  promptSection?: string[];
  relativePath?: string;
  runtime?: ReturnType<typeof createMemoryRuntime>;
}) {
  if (params.promptSection) {
    registerMemoryPromptSection(() => params.promptSection ?? []);
  }
  if (params.relativePath) {
    const relativePath = params.relativePath;
    registerMemoryFlushPlanResolver(() => createMemoryFlushPlan(relativePath));
  }
  if (params.runtime) {
    registerMemoryRuntime(params.runtime);
  }
}

describe("memory plugin state", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("returns empty defaults when no memory plugin state is registered", () => {
    expectClearedMemoryState();
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
    const runtime = createMemoryRuntime();

    registerMemoryRuntime(runtime);

    expect(getMemoryRuntime()).toBe(runtime);
    await expect(
      getMemoryRuntime()?.getMemorySearchManager({
        cfg: {} as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "missing" });
  });

  it("prefers capability registrations and preserves them across restore", async () => {
    const runtime = createMemoryRuntime();
    const artifact = {
      workspaceDir: "/tmp/workspace",
      relativePath: "memory/today.md",
      absolutePath: "/tmp/workspace/memory/today.md",
      kind: "markdown",
      contentType: "text/markdown",
      agentIds: ["main"],
    };

    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["capability section"],
      flushPlanResolver: () => createMemoryFlushPlan("memory/capability.md"),
      runtime,
      publicArtifacts: {
        listArtifacts: async () => [artifact],
      },
    });

    const snapshot = createMemoryStateSnapshot();
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["capability section"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/capability.md");
    expect(getMemoryRuntime()).toBe(runtime);
    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      artifact,
    ]);

    clearMemoryPluginState();
    restoreMemoryPluginState(snapshot);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["capability section"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/capability.md");
    expect(getMemoryRuntime()).toBe(runtime);
    expect(getMemoryCapabilityRegistration()?.pluginId).toBe("memory-core");
  });

  it("restoreMemoryPluginState swaps both prompt and flush state", () => {
    const runtime = createMemoryRuntime();
    registerMemoryState({
      promptSection: ["first"],
      relativePath: "memory/first.md",
      runtime,
    });
    const snapshot = createMemoryStateSnapshot();

    _resetMemoryPluginState();
    expectClearedMemoryState();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["first"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
    expect(getMemoryRuntime()).toBe(runtime);
  });

  it("clearMemoryPluginState resets both registries", () => {
    registerMemoryState({
      promptSection: ["stale section"],
      relativePath: "memory/stale.md",
      runtime: createMemoryRuntime(),
    });

    clearMemoryPluginState();

    expectClearedMemoryState();
  });
});
