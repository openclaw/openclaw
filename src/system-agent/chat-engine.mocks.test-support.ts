import { afterEach, vi } from "vitest";

const operationMocks = vi.hoisted(() => ({
  runConfigSet: vi.fn<typeof import("../cli/config-cli.js").runConfigSet>(),
  runConfigUnset: vi.fn<typeof import("../cli/config-cli.js").runConfigUnset>(),
  createAgent: vi.fn<typeof import("../agents/agent-create.js").createAgent>(),
  applySetup: vi.fn<typeof import("./setup-apply.js").applySystemAgentSetup>(),
  verifyInferenceConfig: vi.fn<typeof import("./setup-inference.js").verifySetupInferenceConfig>(),
}));

export { operationMocks };

vi.mock("../cli/config-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/config-cli.js")>()),
  runConfigSet: operationMocks.runConfigSet,
  runConfigUnset: operationMocks.runConfigUnset,
}));
vi.mock("../agents/agent-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-create.js")>()),
  createAgent: operationMocks.createAgent,
}));
vi.mock("./setup-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-apply.js")>()),
  applySystemAgentSetup: operationMocks.applySetup,
}));
vi.mock("./setup-inference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-inference.js")>()),
  verifySetupInferenceConfig: operationMocks.verifyInferenceConfig,
}));

afterEach(() => {
  for (const mock of Object.values(operationMocks)) {
    mock.mockReset();
  }
});

// Chat-engine tests own verified-operation behavior, not provider/plugin discovery.
// Keep fixture routes ownerless so these tests do not scan the bundled plugin graph.
vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));
