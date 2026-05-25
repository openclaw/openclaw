import { afterEach, describe, expect, it } from "vitest";
import {
  resetMemoryPluginState,
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryRuntime,
  getMemoryRuntimeForPlugin,
  hasMemoryRuntime,
  listMemoryCapabilityRegistrations,
  listMemoryRuntimeRegistrations,
  listMemoryCorpusSupplements,
  listMemoryPromptSupplements,
  listActiveMemoryPublicArtifacts,
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
  expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toStrictEqual(
    [],
  );
  expect(listMemoryCorpusSupplements()).toStrictEqual([]);
  expect(listMemoryRuntimeRegistrations()).toStrictEqual([]);
  expect(getMemoryRuntime()).toBeUndefined();
}

function createMemoryStateSnapshot() {
  return {
    capability: getMemoryCapabilityRegistration(),
    capabilities: listMemoryCapabilityRegistrations(),
    corpusSupplements: listMemoryCorpusSupplements(),
    runtimes: listMemoryRuntimeRegistrations(),
    promptSupplements: listMemoryPromptSupplements(),
  };
}

function registerMemoryState(params: {
  promptSection?: string[];
  relativePath?: string;
  runtime?: ReturnType<typeof createMemoryRuntime>;
}) {
  registerMemoryCapability("memory-core", {
    ...(params.promptSection ? { promptBuilder: () => params.promptSection ?? [] } : {}),
    ...(params.relativePath
      ? { flushPlanResolver: () => createMemoryFlushPlan(params.relativePath ?? "") }
      : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
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

  it("adapts deprecated split registration to the unified memory capability", () => {
    const runtime = createMemoryRuntime();
    const promptBuilder = () => ["legacy prompt"];
    const flushPlanResolver = () => createMemoryFlushPlan("memory/legacy.md");

    registerMemoryPromptSection(promptBuilder);
    registerMemoryFlushPlanResolver(flushPlanResolver);
    registerMemoryRuntime(runtime);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["legacy prompt"]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/legacy.md");
    expect(getMemoryRuntime()).toBe(runtime);
    expect(getMemoryRuntimeForPlugin("legacy-memory-v1")).toBe(runtime);
    expect(getMemoryCapabilityRegistration()).toStrictEqual({
      pluginId: "legacy-memory-v1",
      capability: {
        promptBuilder,
        flushPlanResolver,
        runtime,
      },
    });
  });

  it("prefers the registered memory capability over earlier legacy split state", async () => {
    const runtime = createMemoryRuntime();
    const promptBuilder = () => ["capability prompt"];
    const flushPlanResolver = () => createMemoryFlushPlan("memory/capability.md");

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
      promptBuilder,
      flushPlanResolver,
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
    expect(getMemoryRuntimeForPlugin("memory-core")).toBe(runtime);
    expect(getMemoryCapabilityRegistration()).toStrictEqual({
      pluginId: "memory-core",
      capability: {
        promptBuilder,
        flushPlanResolver,
        runtime,
      },
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

    await expect(
      listActiveMemoryPublicArtifacts({
        cfg: {} as never,
      }),
    ).resolves.toEqual([
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

  it("preserves sidecar runtime fields when a memory plugin adds public artifacts only", async () => {
    const runtime = createMemoryRuntime();
    const flushPlanResolver = () => createMemoryFlushPlan("memory/sidecar.md");

    registerMemoryCapability("memory-core", {
      flushPlanResolver,
      runtime,
    });
    registerMemoryCapability("memory-lancedb", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/sidecar.md");
    expect(getMemoryRuntime()).toBe(runtime);
    expect(getMemoryRuntimeForPlugin("memory-core")).toBe(runtime);
    expect(getMemoryRuntimeForPlugin("memory-lancedb")).toBeUndefined();
    expect(getMemoryCapabilityRegistration()?.pluginId).toBe("memory-lancedb");
    await expect(
      listActiveMemoryPublicArtifacts({
        cfg: { plugins: { slots: { memory: "memory-lancedb" } } } as never,
      }),
    ).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
  });

  it("routes prompt, flush, and public artifacts through the selected recall plugin", async () => {
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["core prompt"],
      flushPlanResolver: () => createMemoryFlushPlan("memory/core.md"),
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "core",
              workspaceDir: "/tmp/core",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/core/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });
    registerMemoryCapability("openclaw-honcho", {
      promptBuilder: () => ["honcho prompt"],
      flushPlanResolver: () => createMemoryFlushPlan("memory/honcho.md"),
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "honcho",
              workspaceDir: "/tmp/honcho",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/honcho/MEMORY.md",
              agentIds: ["honcho-agent"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });
    const cfg = {
      plugins: {
        slots: {
          "memory.recall": "memory-core",
        },
      },
      agents: {
        list: [
          {
            id: "honcho-agent",
            plugins: {
              slots: {
                "memory.recall": "openclaw-honcho",
              },
            },
          },
        ],
      },
    };

    expect(
      buildMemoryPromptSection({
        cfg: cfg as never,
        agentId: "main",
        availableTools: new Set(),
      }),
    ).toEqual(["core prompt"]);
    expect(resolveMemoryFlushPlan({ cfg: cfg as never, agentId: "main" })?.relativePath).toBe(
      "memory/core.md",
    );
    await expect(
      listActiveMemoryPublicArtifacts({ cfg: cfg as never, agentId: "main" }),
    ).resolves.toEqual([
      {
        kind: "core",
        workspaceDir: "/tmp/core",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/core/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    expect(
      buildMemoryPromptSection({
        cfg: cfg as never,
        agentId: "honcho-agent",
        availableTools: new Set(),
      }),
    ).toEqual(["honcho prompt"]);
    expect(
      resolveMemoryFlushPlan({ cfg: cfg as never, agentId: "honcho-agent" })?.relativePath,
    ).toBe("memory/honcho.md");
    await expect(
      listActiveMemoryPublicArtifacts({ cfg: cfg as never, agentId: "honcho-agent" }),
    ).resolves.toEqual([
      {
        kind: "honcho",
        workspaceDir: "/tmp/honcho",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/honcho/MEMORY.md",
        agentIds: ["honcho-agent"],
        contentType: "markdown",
      },
    ]);
  });

  it("returns no selected capability when the recall slot is disabled", () => {
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["core prompt"],
      flushPlanResolver: () => createMemoryFlushPlan("memory/core.md"),
    });

    const cfg = {
      plugins: {
        slots: {
          "memory.recall": "none",
        },
      },
    };

    expect(
      buildMemoryPromptSection({
        cfg: cfg as never,
        availableTools: new Set(),
      }),
    ).toEqual([]);
    expect(resolveMemoryFlushPlan({ cfg: cfg as never })).toBeNull();
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
    expect(getMemoryRuntimeForPlugin("legacy-memory-v1")).toBe(runtime);
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

    resetMemoryPluginState();
    expectClearedMemoryState();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "first",
      "wiki supplement",
    ]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(getMemoryRuntime()).toBe(runtime);
    expect(getMemoryRuntimeForPlugin("memory-core")).toBe(runtime);
  });

  it("keeps plugin-id keyed runtimes for multiple recall-capable plugins", async () => {
    const coreRuntime = createMemoryRuntime();
    const lancedbRuntime = createMemoryRuntime();

    registerMemoryCapability("memory-core", {
      runtime: coreRuntime,
    });
    registerMemoryCapability("memory-lancedb", {
      runtime: lancedbRuntime,
    });

    expect(getMemoryRuntime()).toBe(lancedbRuntime);
    expect(getMemoryRuntimeForPlugin("memory-core")).toBe(coreRuntime);
    expect(getMemoryRuntimeForPlugin("memory-lancedb")).toBe(lancedbRuntime);
    expect(listMemoryRuntimeRegistrations()).toEqual([
      { pluginId: "memory-core", runtime: coreRuntime },
      { pluginId: "memory-lancedb", runtime: lancedbRuntime },
    ]);
    expect(
      listMemoryCapabilityRegistrations().map((registration) => registration.pluginId),
    ).toEqual(["memory-core", "memory-lancedb"]);
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
