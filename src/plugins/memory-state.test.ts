import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMemoryPluginState,
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  getMemoryRuntime,
  hasMemoryRuntime,
  listMemoryCorpusSupplements,
  listMemoryPromptSupplements,
  listActiveMemoryPublicArtifacts,
  mergeMemoryPluginState,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSupplement,
  registerMemoryPromptSection,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
  restoreMemoryPluginState,
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
  expect(listMemoryCorpusSupplements()).toEqual([]);
  expect(getMemoryRuntime()).toBeUndefined();
}

function createMemoryStateSnapshot() {
  return {
    capability: getMemoryCapabilityRegistration(),
    corpusSupplements: listMemoryCorpusSupplements(),
    promptBuilder: getMemoryPromptSectionBuilder(),
    promptSupplements: listMemoryPromptSupplements(),
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

  it("prefers the registered memory capability over legacy split state", async () => {
    const runtime = createMemoryRuntime();

    registerMemoryPromptSection(() => ["legacy prompt"]);
    registerMemoryFlushPlanResolver(() => createMemoryFlushPlan("memory/legacy.md"));
    registerMemoryRuntime({
      async getMemorySearchManager() {
        return { manager: null, error: "legacy" };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    });
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["capability prompt"],
      flushPlanResolver: () => createMemoryFlushPlan("memory/capability.md"),
      runtime,
    });

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["capability prompt"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/capability.md");
    await expect(
      getMemoryRuntime()?.getMemorySearchManager({
        cfg: {} as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "missing" });
    expect(hasMemoryRuntime()).toBe(true);
    expect(getMemoryCapabilityRegistration()).toMatchObject({
      pluginId: "memory-core",
    });
  });

  it("lists active public memory artifacts in deterministic order", async () => {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "daily-note",
              workspaceDir: "/tmp/workspace-b",
              relativePath: "memory/2026-04-06.md",
              absolutePath: "/tmp/workspace-b/memory/2026-04-06.md",
              agentIds: ["beta"],
              contentType: "markdown" as const,
            },
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace-a",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace-a/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace-a",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace-a/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir: "/tmp/workspace-b",
        relativePath: "memory/2026-04-06.md",
        absolutePath: "/tmp/workspace-b/memory/2026-04-06.md",
        agentIds: ["beta"],
        contentType: "markdown",
      },
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

  it("appends prompt supplements in plugin-id order", () => {
    registerMemoryPromptSection(() => ["primary"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki"]);
    registerMemoryPromptSupplement("alpha-helper", () => ["alpha"]);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "primary",
      "alpha",
      "wiki",
    ]);
  });

  it("ignores malformed prompt builder output", () => {
    registerMemoryPromptSection(() => ["primary", 1, undefined] as never);
    registerMemoryPromptSupplement("async-helper", () => Promise.resolve(["async"]) as never);
    registerMemoryPromptSupplement("valid-helper", () => ["valid", false] as never);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["primary", "valid"]);
  });

  it("stores memory corpus supplements", async () => {
    const supplement = {
      search: async () => [{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }],
      get: async () => null,
    };

    registerMemoryCorpusSupplement("memory-wiki", supplement);

    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    await expect(
      listMemoryCorpusSupplements()[0]?.supplement.search({ query: "alpha" }),
    ).resolves.toEqual([{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }]);
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

  it("restoreMemoryPluginState swaps both prompt and flush state", () => {
    const runtime = createMemoryRuntime();
    registerMemoryState({
      promptSection: ["first"],
      relativePath: "memory/first.md",
      runtime,
    });
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki supplement"]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }],
      get: async () => null,
    });
    const snapshot = createMemoryStateSnapshot();

    _resetMemoryPluginState();
    expectClearedMemoryState();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "first",
      "wiki supplement",
    ]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(getMemoryRuntime()).toBe(runtime);
  });

  it("mergeMemoryPluginState preserves a live capability when merging empty state", () => {
    const runtime = createMemoryRuntime();
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["core prompt"],
      runtime,
    });

    // A stale or cache-hit snapshot with no capability must not clobber a
    // live registration. Previously the cache-hit path called
    // restoreMemoryPluginState, which reset memoryPluginState.capability to
    // undefined and caused listActiveMemoryPublicArtifacts to return [] and
    // memory-wiki bridge imports to prune all synced source pages. The
    // cache-hit path now calls mergeMemoryPluginState (this function), which
    // only overwrites fields carrying a non-empty value.
    mergeMemoryPluginState({
      capability: undefined,
      corpusSupplements: [],
      promptSupplements: [],
    });

    expect(getMemoryCapabilityRegistration()).toMatchObject({ pluginId: "memory-core" });
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["core prompt"]);
    expect(getMemoryRuntime()).toBe(runtime);
  });

  it("restoreMemoryPluginState clears a live capability when swap-restoring empty state", () => {
    const runtime = createMemoryRuntime();
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["core prompt"],
      runtime,
    });
    registerMemoryPromptSupplement("stale", () => ["stale supplement"]);

    // restoreMemoryPluginState is the destructive swap used by rollback paths
    // where newly-registered state from a failed plugin must be wiped back to
    // the captured pre-register snapshot — even when that snapshot is empty.
    // Without this semantic, loader.ts's register-rollback path would leave
    // stale supplements behind (covered by loader.test.ts "clears
    // newly-registered memory plugin registries when plugin register fails").
    restoreMemoryPluginState({
      capability: undefined,
      corpusSupplements: [],
      promptSupplements: [],
    });

    expect(getMemoryCapabilityRegistration()).toBeUndefined();
    expect(listMemoryPromptSupplements()).toHaveLength(0);
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
