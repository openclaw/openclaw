import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import type { MemoryPluginCapability } from "./registry-contribution-types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createStubMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { manager: null, error: "missing" } as const;
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

function fixture() {
  const { config, registry } = createPluginRegistryFixture();
  const add = (
    id: string,
    capability: MemoryPluginCapability | MemoryPluginCapability[],
    fields: Partial<Parameters<typeof createPluginRecord>[0]> = {},
  ) => {
    const record = createPluginRecord({ id, kind: "memory", ...fields });
    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        for (const value of Array.isArray(capability) ? capability : [capability]) {
          api.registerMemoryCapability(value);
        }
      },
    });
    return record;
  };
  const selected = () => resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities);
  const checkRuntime = async (owner: ReturnType<typeof selected>) => {
    const runtime = owner?.capability.runtime;
    const params = { cfg: config, agentId: "main" };
    expect(runtime?.resolveMemoryBackendConfig(params)).toEqual({ backend: "builtin" });
    await expect(runtime?.getMemorySearchManager(params)).resolves.toEqual({
      manager: null,
      error: "missing",
    });
  };
  const checkConsolidation = async (owner: ReturnType<typeof selected>, prompt: string) => {
    const capability = owner?.capability;
    expect(capability?.promptBuilder?.({ availableTools: new Set() })).toEqual([prompt]);
    expect(capability?.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(capability?.publicArtifacts?.listArtifacts({ cfg: config })).resolves.toEqual([]);
  };
  return { config, registry, add, selected, checkRuntime, checkConsolidation };
}

const publicArtifacts = () => ({ listArtifacts: async () => [] });

describe("memory capability ownership", () => {
  it("blocks memory registration for an unselected dual-kind plugin", () => {
    const { registry, add } = fixture();
    add(
      "dual-plugin",
      { runtime: createStubMemoryRuntime() },
      { kind: ["memory", "context-engine"] },
    );
    expect(registry.registry.memoryCapabilities).toEqual([]);
    expect(registry.registry.diagnostics).toEqual([
      expect.objectContaining({
        pluginId: "dual-plugin",
        level: "warn",
        message:
          "dual-kind plugin not selected for memory slot; skipping memory capability registration",
      }),
    ]);
  });

  it("layers public artifacts over a selected dual-kind plugin's runtime capability", async () => {
    const { registry, add, selected, checkRuntime, checkConsolidation } = fixture();
    add(
      "memory-core",
      [
        {
          runtime: createStubMemoryRuntime(),
          promptBuilder: () => ["memory capability"],
          flushPlanResolver: () => null,
        },
        { publicArtifacts: publicArtifacts() },
      ],
      { kind: ["memory", "context-engine"], memorySlotSelected: true },
    );
    const owner = selected();
    expect(owner).toMatchObject({ pluginId: "memory-core", memorySlotSelected: true });
    await checkRuntime(owner);
    await checkConsolidation(owner, "memory capability");
    expect(registry.registry.diagnostics).toEqual([]);
  });

  it("preserves an earlier capability when an artifact bridge fails", () => {
    const { config, registry, add, selected } = fixture();
    add(
      "memory-core",
      { runtime: createStubMemoryRuntime(), flushPlanResolver: () => null },
      { memorySlotSelected: true },
    );
    const bridge = createPluginRecord({ id: "memory-bridge", kind: "memory" });
    expect(() =>
      registerTestPlugin({
        registry,
        config,
        record: bridge,
        register(api) {
          api.registerMemoryCapability({ publicArtifacts: publicArtifacts() });
          throw new Error("bridge failed");
        },
      }),
    ).toThrow("bridge failed");
    registry.rollbackPluginGlobalSideEffects(bridge.id, bridge);
    expect(registry.registry.memoryCapabilities).toHaveLength(1);
    const owner = selected();
    expect(owner).toMatchObject({ pluginId: "memory-core", memorySlotSelected: true });
    expect(owner?.capability.publicArtifacts).toBeUndefined();
    expect(
      owner?.capability.runtime?.resolveMemoryBackendConfig({ cfg: config, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
    expect(owner?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
  });

  it("keeps last-registration-wins behavior when neither registration owns the slot", () => {
    const promptBuilder = () => ["replacement prompt"];
    expect(
      resolveMemoryCapabilityRegistration([
        { pluginId: "memory-first", capability: { runtime: createStubMemoryRuntime() } },
        { pluginId: "memory-second", capability: { promptBuilder } },
      ]),
    ).toEqual({
      pluginId: "memory-second",
      capability: { promptBuilder },
      memorySlotSelected: undefined,
    });
  });

  it("merges sidecar consolidation without lending its recall authorization to the slot owner", async () => {
    const { add, selected, checkRuntime, checkConsolidation } = fixture();
    add(
      "acme-memory",
      { runtime: createStubMemoryRuntime(), recallToolNames: ["acme_recall"] },
      { memorySlotSelected: true },
    );
    add("memory-core", {
      runtime: createStubMemoryRuntime(),
      providerRuntime: {
        async open() {
          return { provider: null };
        },
      },
      recallToolNames: ["memory_search", "memory_get"],
      deterministicRecallToolName: "memory_search",
      supportsPrivateTranscriptRecall: true,
      promptBuilder: () => ["sidecar prompt"],
      flushPlanResolver: () => null,
      publicArtifacts: publicArtifacts(),
    });
    const owner = selected();
    expect(owner).toMatchObject({ pluginId: "acme-memory", memorySlotSelected: true });
    expect(owner?.capability.providerRuntime).toBeUndefined();
    expect(owner?.capability.deterministicRecallToolName).toBeUndefined();
    expect(owner?.capability.recallToolNames).toEqual(["acme_recall"]);
    expect(owner?.capability.supportsPrivateTranscriptRecall).toBeUndefined();
    await checkRuntime(owner);
    await checkConsolidation(owner, "sidecar prompt");
  });
});
