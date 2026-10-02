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
    capability: MemoryPluginCapability,
    fields: Partial<Parameters<typeof createPluginRecord>[0]> = {},
  ) => {
    const record = createPluginRecord({ id, kind: "memory", ...fields });
    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.registerMemoryCapability(capability);
      },
    });
    return record;
  };
  const selected = () => resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities);
  return { config, registry, add, selected };
}

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
    const { config, registry, selected } = fixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-core",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({
          runtime: createStubMemoryRuntime(),
          promptBuilder: () => ["memory capability"],
          flushPlanResolver: () => null,
        });
        api.registerMemoryCapability({ publicArtifacts: { listArtifacts: async () => [] } });
      },
    });
    const owner = selected();
    expect(owner?.pluginId).toBe("memory-core");
    expect(owner?.memorySlotSelected).toBe(true);
    expect(
      owner?.capability.runtime?.resolveMemoryBackendConfig({ cfg: config, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
    await expect(
      owner?.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
    expect(owner?.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "memory capability",
    ]);
    expect(owner?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      owner?.capability.publicArtifacts?.listArtifacts({ cfg: config }),
    ).resolves.toEqual([]);
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
          api.registerMemoryCapability({ publicArtifacts: { listArtifacts: async () => [] } });
          throw new Error("bridge failed");
        },
      }),
    ).toThrow("bridge failed");
    registry.rollbackPluginGlobalSideEffects(bridge.id, bridge);
    expect(registry.registry.memoryCapabilities).toHaveLength(1);
    const owner = selected();
    expect(owner?.pluginId).toBe("memory-core");
    expect(owner?.memorySlotSelected).toBe(true);
    expect(owner?.capability.publicArtifacts).toBeUndefined();
    expect(
      owner?.capability.runtime?.resolveMemoryBackendConfig({ cfg: config, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
    expect(owner?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
  });

  it("layers a separately registered dreaming provider over its runtime capability", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const getStatus = async () => ({ enabled: true });
    const record = createPluginRecord({
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      memorySlotSelected: true,
    });

    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.registerMemoryCapability({ runtime, flushPlanResolver });
        api.registerMemoryCapability({ dreaming: { getStatus } });
      },
    });

    const selected = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities);
    // The later dreaming-only call must not drop the runtime memory search needs.
    await expect(
      selected?.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
    expect(selected?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      selected?.capability.dreaming?.getStatus({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ enabled: true });
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

  it("keeps sidecar consolidation while dropping its indexing runtime", () => {
    const { config, registry, add, selected } = fixture();
    add("memory-core", {
      runtime: createStubMemoryRuntime(),
      promptBuilder: () => ["memory prompt"],
      flushPlanResolver: () => null,
    });
    const sidecar = selected();
    expect(sidecar?.capability.runtime).toBeUndefined();
    expect(sidecar?.pluginId).toBe("memory-core");
    expect(sidecar?.memorySlotSelected).toBe(false);
    expect(sidecar?.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "memory prompt",
    ]);
    expect(sidecar?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    expect(registry.registry.diagnostics.filter(({ level }) => level === "warn")).toHaveLength(1);
  });

  it("merges sidecar consolidation without lending its recall authorization to the slot owner", async () => {
    const { config, add, selected } = fixture();
    add("acme-memory", { runtime: createStubMemoryRuntime() }, { memorySlotSelected: true });
    add("memory-core", {
      deterministicRecallToolName: "memory_search",
      supportsPrivateTranscriptRecall: true,
      promptBuilder: () => ["sidecar prompt"],
      flushPlanResolver: () => null,
      publicArtifacts: { listArtifacts: async () => [] },
    });
    const owner = selected();
    expect(owner?.pluginId).toBe("acme-memory");
    expect(owner?.memorySlotSelected).toBe(true);
    expect(owner?.capability.deterministicRecallToolName).toBeUndefined();
    expect(owner?.capability.supportsPrivateTranscriptRecall).toBeUndefined();
    await expect(
      owner?.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
    expect(owner?.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "sidecar prompt",
    ]);
    expect(owner?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      owner?.capability.publicArtifacts?.listArtifacts({ cfg: config }),
    ).resolves.toEqual([]);
  });
});
