// Covers plugin-backed memory state registration and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryRuntime,
  getMemoryRuntimeForPlugin,
  listMemoryCapabilityRegistrations,
  listMemoryRuntimeRegistrations,
  listMemoryCorpusSupplements,
  listMemoryPromptPreparations,
  listMemoryPromptSupplements,
  listActiveMemoryPublicArtifacts,
  prepareMemoryPromptSection,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryPromptPreparation,
  registerMemoryPromptSupplement,
  resolveMemoryFlushPlan,
  restoreMemoryPluginState,
  type MemoryPluginPublicArtifact,
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
    promptPreparations: listMemoryPromptPreparations(),
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

function registerSelectableMemoryCapability(params: {
  pluginId: string;
  label: string;
  agentIds: string[];
}) {
  registerMemoryCapability(params.pluginId, {
    promptBuilder: () => [`${params.label} prompt`],
    flushPlanResolver: () => createMemoryFlushPlan(`memory/${params.label}.md`),
    publicArtifacts: {
      async listArtifacts() {
        return [
          {
            kind: params.label,
            workspaceDir: `/tmp/${params.label}`,
            relativePath: "MEMORY.md",
            absolutePath: `/tmp/${params.label}/MEMORY.md`,
            agentIds: params.agentIds,
            contentType: "markdown" as const,
          },
        ];
      },
    },
  });
}

async function expectSelectedRecallCapability(params: {
  cfg: unknown;
  agentId: string;
  label: string;
  pluginId: string;
}) {
  const context = { cfg: params.cfg as never, agentId: params.agentId };
  expect(buildMemoryPromptSection({ ...context, availableTools: new Set() })).toEqual([
    `${params.label} prompt`,
  ]);
  expect(resolveMemoryFlushPlan(context)?.relativePath).toBe(`memory/${params.label}.md`);
  await expect(listActiveMemoryPublicArtifacts(context)).resolves.toEqual([
    {
      kind: params.label,
      workspaceDir: `/tmp/${params.label}`,
      relativePath: "MEMORY.md",
      absolutePath: `/tmp/${params.label}/MEMORY.md`,
      agentIds: [params.agentId],
      contentType: "markdown",
    },
  ]);
  expect(getMemoryCapabilityRegistration(context)?.pluginId).toBe(params.pluginId);
}

describe("memory plugin state", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("returns empty defaults when no memory plugin state is registered", () => {
    expectClearedMemoryState();
  });

  it("delegates prompt building to the registered memory plugin", () => {
    registerMemoryCapability("memory-core", {
      promptBuilder: ({ availableTools }) => {
        if (!availableTools.has("memory_search")) {
          return [];
        }
        return ["## Custom Memory", "Use custom memory tools.", ""];
      },
    });

    expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([
      "## Custom Memory",
      "Use custom memory tools.",
      "",
    ]);
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

  it("normalizes public memory artifacts without agent ids", async () => {
    const legacyArtifact = {
      kind: "memory-root",
      workspaceDir: "/tmp/workspace",
      relativePath: "MEMORY.md",
      absolutePath: "/tmp/workspace/MEMORY.md",
      contentType: "markdown" as const,
    } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact;

    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [legacyArtifact];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: [],
        contentType: "markdown",
      },
    ]);
  });

  it("drops malformed public memory artifacts instead of crashing the sort", async () => {
    // Record-shaped artifact as shipped by @mem0/openclaw-mem0 <= 1.0.14 —
    // none of the file-backed fields the sort dereferences.
    const recordShapedArtifact = {
      id: "mem0:memory:1",
      type: "memory",
      title: "A memory",
      content: "memory text",
    } as unknown as MemoryPluginPublicArtifact;

    registerMemoryCapability("openclaw-mem0", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            recordShapedArtifact,
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

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
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

  it("ignores a non-array public artifact listing", async () => {
    registerMemoryCapability("openclaw-mem0", {
      publicArtifacts: {
        async listArtifacts() {
          return { artifacts: [] } as unknown as MemoryPluginPublicArtifact[];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([]);
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
        cfg: { plugins: { slots: { "memory.recall": "memory-lancedb" } } } as never,
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
    registerSelectableMemoryCapability({
      pluginId: "memory-core",
      label: "core",
      agentIds: ["main"],
    });
    registerSelectableMemoryCapability({
      pluginId: "openclaw-honcho",
      label: "honcho",
      agentIds: ["honcho-agent"],
    });
    const cfg = {
      plugins: { slots: { "memory.recall": "memory-core" } },
      agents: {
        list: [
          {
            id: "honcho-agent",
            plugins: { slots: { "memory.recall": "openclaw-honcho" } },
          },
        ],
      },
    };

    await expectSelectedRecallCapability({
      cfg,
      agentId: "main",
      label: "core",
      pluginId: "memory-core",
    });
    await expectSelectedRecallCapability({
      cfg,
      agentId: "honcho-agent",
      label: "honcho",
      pluginId: "openclaw-honcho",
    });
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
    expect(getMemoryCapabilityRegistration({ cfg: cfg as never })).toBeUndefined();
  });

  it("passes citations mode through to the prompt builder", () => {
    registerMemoryCapability("memory-core", {
      promptBuilder: ({ citationsMode }) => [`citations: ${citationsMode ?? "default"}`],
    });

    expect(
      buildMemoryPromptSection({
        availableTools: new Set(),
        citationsMode: "off",
      }),
    ).toEqual(["citations: off"]);
  });

  it("passes agent context through the primary and supplemental prompt builders", () => {
    const primary = vi.fn(() => ["primary"]);
    const supplemental = vi.fn(() => ["supplemental"]);
    registerMemoryCapability("memory-core", { promptBuilder: primary });
    registerMemoryPromptSupplement("memory-wiki", supplemental);

    const availableTools = new Set(["memory_search", "memory_get"]);
    expect(
      buildMemoryPromptSection({
        availableTools,
        citationsMode: "on",
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      }),
    ).toEqual(["primary", "supplemental"]);
    const expectedContext = {
      availableTools,
      citationsMode: "on",
      agentId: "marketing-agent",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    };
    expect(primary).toHaveBeenCalledWith(expectedContext);
    expect(supplemental).toHaveBeenCalledWith(expectedContext);
  });

  it("appends prompt supplements in plugin-id order", () => {
    registerMemoryCapability("memory-core", { promptBuilder: () => ["primary"] });
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki"]);
    registerMemoryPromptSupplement("alpha-helper", () => ["alpha"]);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "primary",
      "alpha",
      "wiki",
    ]);
  });

  it("ignores malformed prompt builder output", () => {
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["primary", 1, undefined] as never,
    });
    registerMemoryPromptSupplement("async-helper", () => Promise.resolve(["async"]) as never);
    registerMemoryPromptSupplement("valid-helper", () => ["valid", false] as never);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["primary", "valid"]);
  });

  it("prepares immutable prompt lines once per run before synchronous assembly", async () => {
    let compiledLines = ["compiled before"];
    const prepare = vi.fn(async () => [...compiledLines]);
    registerMemoryPromptPreparation("memory-wiki", prepare);
    const params = {
      availableTools: new Set(["wiki_search"]),
      agentId: "main",
      agentSessionKey: "agent:main:main",
    };

    const preparedBefore = await prepareMemoryPromptSection(params);
    compiledLines = ["compiled after"];

    expect(Object.isFrozen(preparedBefore)).toBe(true);
    expect(Object.isFrozen(preparedBefore.context)).toBe(true);
    expect(Object.isFrozen(preparedBefore.context.availableTools)).toBe(true);
    expect(Object.isFrozen(preparedBefore.lines)).toBe(true);
    expect(buildMemoryPromptSection(params, preparedBefore)).toEqual(["compiled before"]);
    expect(buildMemoryPromptSection(params, preparedBefore)).toEqual(["compiled before"]);
    expect(prepare).toHaveBeenCalledTimes(1);

    const preparedAfter = await prepareMemoryPromptSection(params);
    expect(buildMemoryPromptSection(params, preparedAfter)).toEqual(["compiled after"]);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects prepared state from a different run context", async () => {
    registerMemoryPromptPreparation("memory-wiki", async () => ["private wiki state"]);
    const prepared = await prepareMemoryPromptSection({
      availableTools: new Set(["wiki_search"]),
      agentId: "first",
      agentSessionKey: "agent:first:main",
    });

    expect(() =>
      buildMemoryPromptSection(
        {
          availableTools: new Set(["wiki_search"]),
          agentId: "second",
          agentSessionKey: "agent:second:main",
        },
        prepared,
      ),
    ).toThrow("prepared memory prompt section does not match the current run");
  });

  it("removes prompt preparations from future runs without mutating an in-flight snapshot", async () => {
    registerMemoryPromptPreparation("memory-wiki", async () => ["prepared wiki"]);
    const params = { availableTools: new Set<string>() };
    const prepared = await prepareMemoryPromptSection(params);

    clearMemoryPluginState();

    const afterRemoval = await prepareMemoryPromptSection(params);
    expect(buildMemoryPromptSection(params, prepared)).toEqual(["prepared wiki"]);
    expect(buildMemoryPromptSection(params, afterRemoval)).toEqual([]);
    expect(listMemoryPromptPreparations()).toEqual([]);
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
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => ({
        softThresholdTokens: 1,
        forceFlushTranscriptBytes: 2,
        reserveTokensFloor: 3,
        prompt: "prompt",
        systemPrompt: "system",
        relativePath: "memory/test.md",
      }),
    });

    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/test.md");
  });

  it("stores the registered memory runtime", async () => {
    const runtime = createMemoryRuntime();

    registerMemoryCapability("memory-core", { runtime });

    expect(getMemoryRuntime()).toBe(runtime);
    expect(getMemoryRuntimeForPlugin("memory-core")).toBe(runtime);
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

    clearMemoryPluginState();
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
