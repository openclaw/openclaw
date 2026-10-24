import { expect, it } from "vitest";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import type { MemoryPluginCapability } from "./registry-contribution-types.js";
import { expectDiagnostic, registrationFixture } from "./registry-registration.test-support.js";

const memoryRuntime = () => ({
  getMemorySearchManager: async () => ({ manager: null, error: "missing" }) as const,
  resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
});
const publicArtifacts = () => ({ listArtifacts: async () => [] });
const consolidation = (prompt: string) => ({
  promptBuilder: () => [prompt],
  flushPlanResolver: () => null,
  publicArtifacts: publicArtifacts(),
});

function fixture() {
  const base = registrationFixture();
  const add = (
    id: string,
    capability: MemoryPluginCapability | MemoryPluginCapability[],
    fields: Partial<Parameters<typeof base.register>[0]> = {},
  ) =>
    base.register({ id, kind: "memory", ...fields }, (api) => {
      for (const value of Array.isArray(capability) ? capability : [capability]) {
        api.registerMemoryCapability(value);
      }
    });
  const selected = () => resolveMemoryCapabilityRegistration(base.registry.memoryCapabilities);
  const inspect = async () => {
    const capability = selected()?.capability;
    const params = { cfg: base.config, agentId: "main" };
    return {
      backend: capability?.runtime?.resolveMemoryBackendConfig(params),
      search: await capability?.runtime?.getMemorySearchManager(params),
      prompt: capability?.promptBuilder?.({ availableTools: new Set() }),
      flush: capability?.flushPlanResolver?.(params),
      artifacts: await capability?.publicArtifacts?.listArtifacts(params),
    };
  };
  const check = async (pluginId: string, prompt?: string) => {
    expect(selected()).toMatchObject({ pluginId, memorySlotSelected: true });
    await expect(inspect()).resolves.toEqual({
      ...runtimeResult,
      prompt: prompt ? [prompt] : undefined,
      flush: null,
      artifacts: prompt ? [] : undefined,
    });
  };
  return { ...base, add, selected, check };
}
const runtimeResult = {
  backend: { backend: "builtin" },
  search: { manager: null, error: "missing" },
};

it("blocks an unselected dual-kind plugin", () => {
  const { registry, add } = fixture();
  add("dual-plugin", { runtime: memoryRuntime() }, { kind: ["memory", "context-engine"] });
  expect(registry.memoryCapabilities).toEqual([]);
  expect(registry.diagnostics).toHaveLength(1);
  expectDiagnostic(registry, {
    pluginId: "dual-plugin",
    level: "warn",
    message:
      "dual-kind plugin not selected for memory slot; skipping memory capability registration",
  });
});

it("layers public artifacts over the selected dual-kind runtime", async () => {
  const { registry, add, check } = fixture();
  const { publicArtifacts: artifacts, ...capability } = consolidation("memory capability");
  add(
    "memory-core",
    [{ runtime: memoryRuntime(), ...capability }, { publicArtifacts: artifacts }],
    { kind: ["memory", "context-engine"], memorySlotSelected: true },
  );
  await check("memory-core", "memory capability");
  expect(registry.diagnostics).toEqual([]);
});

it("preserves an earlier capability when an artifact bridge fails", async () => {
  const { registry, register, rollback, add, selected, check } = fixture();
  add(
    "memory-core",
    { runtime: memoryRuntime(), flushPlanResolver: () => null },
    { memorySlotSelected: true },
  );
  expect(() =>
    register({ id: "memory-bridge", kind: "memory" }, (api) => {
      api.registerMemoryCapability({ publicArtifacts: publicArtifacts() });
      throw new Error("bridge failed");
    }),
  ).toThrow("bridge failed");
  const bridge = registry.plugins.find(({ id }) => id === "memory-bridge")!;
  rollback(bridge.id, bridge);
  expect(registry.memoryCapabilities).toHaveLength(1);
  expect(selected()?.capability.publicArtifacts).toBeUndefined();
  await check("memory-core");
});

it("uses the last registration when neither owns the slot", () => {
  const promptBuilder = () => ["replacement prompt"];
  expect(
    resolveMemoryCapabilityRegistration([
      { pluginId: "memory-first", capability: { runtime: memoryRuntime() } },
      { pluginId: "memory-second", capability: { promptBuilder } },
    ]),
  ).toEqual({
    pluginId: "memory-second",
    capability: { promptBuilder },
    memorySlotSelected: undefined,
  });
});

it("merges sidecar consolidation without lending its recall authorization", async () => {
  const { add, selected, check } = fixture();
  add(
    "acme-memory",
    { runtime: memoryRuntime(), recallToolNames: ["acme_recall"] },
    { memorySlotSelected: true },
  );
  add("memory-core", {
    ...consolidation("sidecar prompt"),
    runtime: memoryRuntime(),
    providerRuntime: { open: async () => ({ provider: null }) },
    recallToolNames: ["memory_search", "memory_get"],
    deterministicRecallToolName: "memory_search",
    supportsPrivateTranscriptRecall: true,
    learnToolNames: ["memory_save"],
    learnGuidanceBuilder: () => ["sidecar learn"],
  });
  const owner = selected();
  expect(owner?.capability.recallToolNames).toEqual(["acme_recall"]);
  expect(owner?.capability.learnToolNames).toBeUndefined();
  expect(owner?.capability.learnGuidanceBuilder).toBeUndefined();
  expect(owner?.capability.providerRuntime).toBeUndefined();
  expect(owner?.capability.deterministicRecallToolName).toBeUndefined();
  expect(owner?.capability.supportsPrivateTranscriptRecall).toBeUndefined();
  await check("acme-memory", "sidecar prompt");
});
