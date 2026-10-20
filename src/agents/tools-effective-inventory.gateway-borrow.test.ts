// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { bindPluginRegistryGatewayOwner } from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { acquireEffectiveToolInventoryRuntimeModelContext } from "./tools-effective-inventory.js";

vi.mock("./embedded-agent-runner/model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedded-agent-runner/model.js")>()),
  resolveModelAsync: async (provider: string, modelId: string) => ({
    model: { id: modelId, name: modelId, provider, api: "openai-responses", baseUrl: "" },
  }),
}));

const fixture = usePreparedModelRuntimeHarness({ label: "tools-effective-gateway-borrow" });
const { mocks } = fixture;

describe("tools.effective dynamic runtime model", () => {
  it("borrows the admitting Gateway's plugin instances instead of loading its own", async () => {
    const config = {};
    const workspaceDir = fixture.state.workspaceDir;
    const metadata = createPluginMetadataSnapshot({
      config,
      workspaceDir,
      manifestRegistry: makeRegistry([]),
    });
    // Preparation must observe the Gateway's workspace so the lender is eligible.
    Object.assign(mocks.pluginMetadataSnapshot, metadata);
    const gateway = createEmptyPluginRegistry();
    bindPluginRegistryGatewayOwner(gateway, { current: () => gateway });
    setPluginRuntimeLoadContext(gateway, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir,
      env: process.env,
      metadataSnapshot: metadata,
      manifestRegistry: metadata.manifestRegistry,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    await withPluginRuntimeRegistryScope(gateway, async () => {
      await using _ = await acquireEffectiveToolInventoryRuntimeModelContext({
        cfg: config,
        agentId: "default",
        agentDir: fixture.agentInput("default", config).agentDir,
        workspaceDir,
        modelProvider: "custom",
        modelId: "dynamic-model",
      });
    });

    const loads = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls;
    expect(loads).toHaveLength(1);
    expect(loads[0]?.[0]).toMatchObject({ borrowRegistry: gateway });
  });
});
