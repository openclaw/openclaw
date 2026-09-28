import { vi } from "vitest";

const registryPersistence = vi.hoisted(() => ({
  persistSubagentRunsToDiskOrThrow:
    vi.fn<
      typeof import("../../agents/subagents/registry/subagent-registry-state.js").persistSubagentRunsToDiskOrThrow
    >(),
}));

vi.mock("../../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >()),
  persistSubagentRunsToDisk: () => {},
  persistSubagentRunsToDiskOrThrow: registryPersistence.persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk: () => 0,
}));
vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));
vi.mock("../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: () => {},
}));
vi.mock("../../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: () => undefined,
}));

export { registryPersistence };
