import { expect, it } from "vitest";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import type { MemoryPluginCapability } from "./registry-contribution-types.js";
import { registrationFixture } from "./registry-registration.test-support.js";

const memoryRuntime = () => ({
  getMemorySearchManager: async () => ({ manager: null, error: "missing" }) as const,
  resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
});
const publicArtifacts = () => ({ listArtifacts: async () => [] });

function fixture() {
  const base = registrationFixture();
  const add = (
    id: string,
    capability: MemoryPluginCapability,
    fields: Partial<Parameters<typeof base.register>[0]> = {},
  ) =>
    base.register({ id, kind: "memory", ...fields }, (api) => {
      api.registerMemoryCapability(capability);
    });
  const selected = () => resolveMemoryCapabilityRegistration(base.registry.memoryCapabilities);
  return { ...base, add, selected };
}

it("blocks an unselected dual-kind plugin", () => {
  const { registry, add } = fixture();
  add("dual-plugin", { runtime: memoryRuntime() }, { kind: ["memory", "context-engine"] });
  expect(registry.memoryCapabilities).toEqual([]);
  expect(registry.diagnostics).toMatchObject([{ pluginId: "dual-plugin", level: "warn" }]);
});

it("preserves an earlier capability when an artifact bridge fails", async () => {
  const { registry, register, rollback, add, selected } = fixture();
  add(
    "memory-core",
    { runtime: memoryRuntime(), flushPlanResolver: () => null },
    { memorySlotSelected: true },
  );
  const before = selected();
  expect(before).toMatchObject({ pluginId: "memory-core", memorySlotSelected: true });
  expect(() =>
    register({ id: "memory-bridge", kind: "memory" }, (api) => {
      api.registerMemoryCapability({ publicArtifacts: publicArtifacts() });
      throw new Error("bridge failed");
    }),
  ).toThrow("bridge failed");
  const bridge = registry.plugins.find(({ id }) => id === "memory-bridge")!;
  rollback(bridge.id, bridge);
  expect(registry.memoryCapabilities).toHaveLength(1);
  expect(selected()).toEqual(before);
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

it("merges sidecar consolidation without lending its recall authorization", () => {
  const { registry, add, selected } = fixture();
  add(
    "acme-memory",
    { runtime: memoryRuntime(), recallToolNames: ["acme_recall"] },
    { kind: ["memory", "context-engine"], memorySlotSelected: true },
  );
  const runtime = selected()?.capability.runtime;
  add("memory-core", {
    promptBuilder: () => ["sidecar prompt"],
    flushPlanResolver: () => null,
    publicArtifacts: publicArtifacts(),
    runtime: memoryRuntime(),
    providerRuntime: { open: async () => ({ provider: null }) },
    recallToolNames: ["memory_search", "memory_get"],
    deterministicRecallToolName: "memory_search",
    supportsPrivateTranscriptRecall: true,
    learnToolNames: ["memory_save"],
    learnGuidanceBuilder: () => ["sidecar learn"],
  });
  const owner = selected();
  expect(owner).toMatchObject({ pluginId: "acme-memory", memorySlotSelected: true });
  const sidecar = registry.memoryCapabilities[1]!.capability;
  expect(owner?.capability).toEqual({
    runtime,
    recallToolNames: ["acme_recall"],
    promptBuilder: sidecar.promptBuilder,
    flushPlanResolver: sidecar.flushPlanResolver,
    publicArtifacts: sidecar.publicArtifacts,
  });
});
