import { afterEach, expect, it, vi } from "vitest";
import {
  adoptRuntimeMemoryRegistrations,
  buildMemoryPromptSection as buildPrompt,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryProviderRuntime,
  getMemoryRuntime,
  listMemoryPromptPreparations,
  listActiveMemoryPublicArtifacts as listArtifacts,
  prepareMemoryPromptSection as preparePrompt,
  registerMemoryCapability as registerCapability,
  registerMemoryCorpusSupplement,
  registerMemoryPromptPreparation as registerPreparation,
  registerMemoryPromptSupplement as registerSupplement,
  registerTestMemoryPromptBuilder as registerBuilder,
  resolveMemoryFlushPlan as flushPlan,
  type MemoryPluginPublicArtifact as Artifact,
} from "./memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

const createMemoryRuntime = () => ({
  getMemorySearchManager: async () => ({ manager: null, error: "missing" }),
  resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
});

const flushTiming = { softThresholdTokens: 1, forceFlushTranscriptBytes: 2, reserveTokensFloor: 3 };
function createMemoryFlushPlan(relativePath: string) {
  return { ...flushTiming, prompt: relativePath, systemPrompt: relativePath, relativePath };
}

const memoryArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  kind: "memory-root",
  workspaceDir: "/tmp/workspace",
  relativePath: "MEMORY.md",
  absolutePath: "/tmp/workspace/MEMORY.md",
  agentIds: ["main"],
  contentType: "markdown",
  ...overrides,
});

function registerArtifacts(pluginId: string, artifacts: Artifact[]) {
  registerCapability(pluginId, { publicArtifacts: { listArtifacts: async () => artifacts } });
}

const promptParams = () => ({
  availableTools: new Set(["wiki_search"]),
  agentId: "first",
  agentSessionKey: "agent:first:main",
});

afterEach(clearMemoryPluginState);
const { agentIds: _agentIds, ...legacyArtifact } = memoryArtifact();
// mem0 <= 1.0.14 supplied records without the file-backed sort fields.
const malformed = { id: "mem0:memory:1", type: "memory" } as unknown as Artifact;
const laterArtifact = memoryArtifact({
  workspaceDir: "/tmp/z",
  absolutePath: "/tmp/z/MEMORY.md",
});

it("keeps a cleared registry absent while reading memory capability state", async () => {
  await clearActivePluginRegistry();
  expect(getMemoryRuntime()).toBeUndefined();
  expect(getMemoryCapabilityRegistration()).toBeUndefined();
  expect(flushPlan({})).toBeNull();
  expect(getActivePluginRegistry()).toBeNull();
});

it("attributes direct builder registrations to the synchronous plugin owner", () => {
  const building = createEmptyPluginRegistry();

  withPluginRegistrationContext(building, "actual-plugin", () => {
    registerCapability("spoofed-plugin", { runtime: createMemoryRuntime() });
    registerMemoryCorpusSupplement("spoofed-plugin", {
      search: async () => [],
      get: async () => null,
    });
    registerSupplement("spoofed-plugin", () => ["supplement"]);
    registerPreparation("spoofed-plugin", async () => ["prepared"]);
  });

  expect(building.memoryCapabilities[0]?.pluginId).toBe("actual-plugin");
  expect(building.memoryCorpusSupplements[0]?.pluginId).toBe("actual-plugin");
  expect(building.memoryPromptSupplements[0]?.pluginId).toBe("actual-plugin");
  expect(building.memoryPromptPreparations[0]?.pluginId).toBe("actual-plugin");
});

it.each([
  ["missing agent ids", [legacyArtifact as Artifact], [memoryArtifact({ agentIds: [] })]],
  [
    "malformed records and unsorted workspaces",
    [malformed, laterArtifact, memoryArtifact()],
    [memoryArtifact(), laterArtifact],
  ],
  ["non-array listings", { artifacts: [] } as unknown as Artifact[], []],
] satisfies Array<[string, Artifact[], Artifact[]]>)(
  "normalizes public memory artifacts with %s",
  async (_shape, input, expected) => {
    registerArtifacts("openclaw-mem0", input);
    await expect(listArtifacts({ cfg: {} })).resolves.toEqual(expected);
  },
);

it("preserves sidecar runtime fields when a memory plugin adds public artifacts only", async () => {
  const runtime = createMemoryRuntime();
  const providerRuntime = { open: async () => ({ provider: null }) };
  const flushPlanResolver = () => createMemoryFlushPlan("memory/sidecar.md");

  registerCapability("memory-core", { flushPlanResolver, providerRuntime, runtime });
  registerArtifacts("memory-lancedb", [memoryArtifact()]);

  expect(flushPlan({})?.plan).toMatchObject({ relativePath: "memory/sidecar.md" });
  expect(getMemoryProviderRuntime()).toBe(providerRuntime);
  expect(getMemoryRuntime()).toBe(runtime);
  expect(getMemoryCapabilityRegistration()?.pluginId).toBe("memory-lancedb");
  await expect(listArtifacts({ cfg: {} })).resolves.toEqual([memoryArtifact()]);
});

it.each([
  { ownerFirst: true, ownerResolver: "provider" },
  { ownerFirst: false, ownerResolver: "provider" },
  { ownerFirst: true, ownerResolver: "released" },
  { ownerFirst: false, ownerResolver: "released" },
  { ownerFirst: true, ownerResolver: undefined },
  { ownerFirst: false, ownerResolver: undefined },
] as const)("retains effective flush resolver provenance through sidecars: %j", (testCase) => {
  const registry = createEmptyPluginRegistry();
  const ownerFilePlan = createMemoryFlushPlan("memory/owner.md");
  const toolsPlan = { systemPrompt: "Persist memories", persistenceToolNames: ["save_memory"] };
  const ownerToolsPlan = { ...toolsPlan, prompt: "Owner tools" };
  const sidecarToolsPlan = { ...toolsPlan, prompt: "Sidecar tools" };
  const owner = {
    pluginId: "memory-provider",
    memorySlotSelected: true,
    capability:
      testCase.ownerResolver === "provider"
        ? { providerFlushPlanResolver: () => ownerToolsPlan }
        : testCase.ownerResolver === "released"
          ? { flushPlanResolver: () => ownerFilePlan }
          : {},
  };
  // The sidecar offers both resolvers; neither may be combined with the owner's.
  const sidecar = {
    pluginId: "memory-sidecar",
    capability: {
      flushPlanResolver: () => createMemoryFlushPlan("memory/sidecar.md"),
      providerFlushPlanResolver: () => sidecarToolsPlan,
    },
  };
  registry.memoryCapabilities.push(
    ...(testCase.ownerFirst ? [owner, sidecar] : [sidecar, owner]),
    // A later merge must not relabel an inherited resolver as slot-owned.
    {
      pluginId: "artifacts-sidecar",
      capability: { publicArtifacts: { listArtifacts: async () => [] } },
    },
  );
  setActivePluginRegistry(registry);

  expect(flushPlan({})).toEqual(
    testCase.ownerResolver
      ? {
          plan: testCase.ownerResolver === "provider" ? ownerToolsPlan : ownerFilePlan,
          pluginId: "memory-provider",
          selectedSlotOwner: true,
        }
      : { plan: sidecarToolsPlan, pluginId: "memory-sidecar", selectedSlotOwner: false },
  );
});

it("appends valid prompt supplements in plugin-id order", () => {
  registerBuilder(() => ["primary", 1, undefined] as never);
  registerSupplement("memory-wiki", () => ["wiki", false] as never);
  registerSupplement("alpha-helper", () => ["alpha"]);
  registerSupplement("async-helper", () => Promise.resolve(["async"]) as never);

  expect(buildPrompt({ availableTools: new Set() })).toEqual(["primary", "alpha", "wiki"]);
});

it("prepares immutable prompt lines once per run before synchronous assembly", async () => {
  let compiledLines = ["compiled before"];
  const prepare = vi.fn(async () => [...compiledLines]);
  registerPreparation("memory-wiki", prepare);
  const params = {
    availableTools: new Set(["wiki_search", "memory_search"]),
    agentId: "main",
    agentSessionKey: "agent:main:main",
  };

  const preparedBefore = await preparePrompt(params);
  compiledLines = ["compiled after"];

  expect(Object.isFrozen(preparedBefore)).toBe(true);
  expect(Object.isFrozen(preparedBefore.context)).toBe(true);
  expect(Object.isFrozen(preparedBefore.context.availableTools)).toBe(true);
  expect(preparedBefore.context.availableTools).toEqual(["memory_search", "wiki_search"]);
  expect([...params.availableTools]).toEqual(["wiki_search", "memory_search"]);
  expect(Object.isFrozen(preparedBefore.lines)).toBe(true);
  expect(buildPrompt(params, preparedBefore)).toEqual(["compiled before"]);
  params.availableTools.delete("wiki_search");
  params.availableTools.add("wiki_search");
  expect(buildPrompt(params, preparedBefore)).toEqual(["compiled before"]);
  expect(prepare).toHaveBeenCalledTimes(1);

  const preparedAfter = await preparePrompt(params);
  expect(buildPrompt(params, preparedAfter)).toEqual(["compiled after"]);
  expect(prepare).toHaveBeenCalledTimes(2);
});

it.each([
  ["agent", { agentId: "second" }],
  ["session", { agentSessionKey: "agent:first:other" }],
  ["citations", { citationsMode: "off" as const }],
  ["sandbox", { sandboxed: true }],
  ["project", { projectKey: "github.com/acme/other" }],
  ["removed tool", { availableTools: new Set<string>() }],
  ["added tool", { availableTools: new Set(["wiki_search", "memory_search"]) }],
  ["replaced tool", { availableTools: new Set(["memory_search"]) }],
])("rejects prepared state after a change to the %s", async (_name, changed) => {
  registerPreparation("memory-wiki", async () => ["private wiki state"]);
  const prepared = await preparePrompt(promptParams());
  expect(() => buildPrompt({ ...promptParams(), ...changed }, prepared)).toThrow(
    "prepared memory prompt section does not match the current run",
  );
});

it("removes prompt preparations from future runs without mutating an in-flight snapshot", async () => {
  registerPreparation("memory-wiki", async () => ["prepared wiki"]);
  const params = { availableTools: new Set<string>() };
  const prepared = await preparePrompt(params);

  clearMemoryPluginState();

  const afterRemoval = await preparePrompt(params);
  expect(buildPrompt(params, prepared)).toEqual(["prepared wiki"]);
  expect(buildPrompt(params, afterRemoval)).toEqual([]);
  expect(listMemoryPromptPreparations()).toEqual([]);
});

it("keeps current preparation order when a callback replaces the registrations", async () => {
  registerSupplement("zeta", () => ["zeta guidance"]);
  registerSupplement("beta", () => ["beta guidance"]);
  registerPreparation("gamma", async () => {
    clearMemoryPluginState();
    registerPreparation("replacement", async () => ["replacement recall"]);
    return ["gamma recall"];
  });
  registerPreparation("alpha", async () => ["alpha recall"]);
  const params = promptParams();

  expect(buildPrompt(params, await preparePrompt(params))).toEqual([
    "alpha recall",
    "beta guidance",
    "gamma recall",
    "zeta guidance",
  ]);
  expect(buildPrompt(params, await preparePrompt(params))).toEqual(["replacement recall"]);
});

it("does not adopt memory sidecars across conflicting plugin owners", () => {
  const supplement = { search: async () => [], get: async () => null };
  const prepare = async () => ["runtime wiki digest"];
  const builder = () => ["runtime wiki guidance"];
  const root = createEmptyPluginRegistry();
  root.plugins.push(createPluginRecord({ id: "memory-wiki", source: "/root/wiki.js" }));
  root.memoryCorpusSupplements.push({ pluginId: "memory-wiki", supplement });
  root.memoryPromptPreparations.push({ pluginId: "memory-wiki", prepare });
  root.memoryPromptSupplements.push({ pluginId: "memory-wiki", builder });
  const scoped = createEmptyPluginRegistry();
  scoped.plugins.push(createPluginRecord({ id: "memory-wiki", source: "/shadow/wiki.js" }));

  expect(
    adoptRuntimeMemoryRegistrations(scoped, root, {
      plugins: { allow: ["memory-wiki"], entries: { "memory-wiki": { enabled: true } } },
    }),
  ).toBe(scoped);
  expect(scoped.memoryCorpusSupplements).toEqual([]);
  expect(scoped.memoryPromptPreparations).toEqual([]);
  expect(scoped.memoryPromptSupplements).toEqual([]);
});
