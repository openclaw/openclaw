import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadOpenClawPlugins } from "./loader.js";
import { writePlugin } from "./loader.test-fixtures.js";
import {
  globalAfterAll1,
  globalAfterEach0,
  setupBundledDreamingMemoryPlugins,
} from "./loader.test-harness.js";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});
afterEach(globalAfterEach0);
afterAll(globalAfterAll1);

function loadWithSidecar(entry: Record<string, unknown>, sidecarId = "memory-sidecar") {
  // Policy keys are lowercase; the manifest id keeps the author's casing.
  const policyId = sidecarId.toLowerCase();
  const { bundledDir } = setupBundledDreamingMemoryPlugins({
    selectedId: sidecarId,
    coreBody: `module.exports = {
      id: "memory-core",
      kind: "memory",
      register(api) {
        api.registerMemoryCapability({ promptBuilder: () => ["owner prompt"] });
      },
    };`,
  });
  writePlugin({
    id: sidecarId,
    dir: path.join(bundledDir, sidecarId),
    filename: "index.cjs",
    body: `module.exports = {
      id: ${JSON.stringify(sidecarId)},
      kind: "memory",
      register(api) {
        api.registerMemoryCapability({
          recallToolNames: ["sidecar_recall"],
          promptBuilder: () => ["sidecar prompt"],
        });
        api.on("before_prompt_build", () => undefined);
      },
    };`,
  });
  return loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        allow: ["memory-core", policyId],
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: true }, [policyId]: entry },
      },
    },
  });
}

describe("memory sidecar plugins", () => {
  it("loads an operator-approved memory plugin beside the slot owner", () => {
    const registry = loadWithSidecar({ enabled: true, memory: { sidecar: true } });
    const core = registry.plugins.find((entry) => entry.id === "memory-core");
    const sidecar = registry.plugins.find((entry) => entry.id === "memory-sidecar");
    expect(core?.status).toBe("loaded");
    expect(core?.memorySlotSelected).toBe(true);
    expect(sidecar?.status).toBe("loaded");
    expect(sidecar?.memorySlotSelected).not.toBe(true);
    expect(registry.typedHooks.some((hook) => hook.pluginId === "memory-sidecar")).toBe(true);
    // The owner keeps the slot; the sidecar's recall grant is dropped by the registrar.
    const resolved = resolveMemoryCapabilityRegistration(registry.memoryCapabilities);
    expect(resolved?.pluginId).toBe("memory-core");
    expect(resolved?.capability.recallToolNames).toBeUndefined();
  });

  it("matches a mixed-case manifest id against its lowercase policy entry", () => {
    const registry = loadWithSidecar({ enabled: true, memory: { sidecar: true } }, "MiXeD-memory");
    const sidecar = registry.plugins.find((entry) => entry.id === "MiXeD-memory");
    expect(sidecar?.status).toBe("loaded");
    expect(sidecar?.memorySlotSelected).not.toBe(true);
    expect(registry.typedHooks.some((hook) => hook.pluginId === "MiXeD-memory")).toBe(true);
    expect(resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.pluginId).toBe(
      "memory-core",
    );
  });

  it("keeps an unapproved memory plugin disabled when another plugin owns the slot", () => {
    const registry = loadWithSidecar({ enabled: true });
    const sidecar = registry.plugins.find((entry) => entry.id === "memory-sidecar");
    expect(sidecar?.status).toBe("disabled");
    expect(registry.typedHooks.some((hook) => hook.pluginId === "memory-sidecar")).toBe(false);
  });
});
