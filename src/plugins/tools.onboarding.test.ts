import { afterEach, expect, it } from "vitest";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { applyLocalSetupWorkspaceConfig } from "../commands/onboard-config.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { resolvePluginTools } from "./tools.js";
import { createToolRuntimeRecord, makeTool } from "./tools.optional.test-helpers.js";

afterEach(() => setCurrentPluginMetadataSnapshot(undefined));

it.each([
  { deny: [], expected: ["optional_tool"] },
  { deny: ["optional_tool"], expected: [] },
])("honors optional-tool deny=$deny after local onboarding", async ({ deny, expected }) => {
  const workspaceDir = "/tmp";
  const config = applyLocalSetupWorkspaceConfig(
    {
      plugins: { enabled: true, load: { paths: ["/tmp/plugin.js"] }, slots: { memory: "none" } },
      tools: { deny },
    },
    workspaceDir,
  );
  const record = createToolRuntimeRecord("optional-demo");
  record.contracts = { tools: ["optional_tool"] };
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: record.id,
        source: record.source,
        rootDir: record.rootDir,
        origin: record.origin,
        enabledByDefault: true,
        contracts: record.contracts,
        toolMetadata: { optional_tool: { optional: true } },
      },
    ],
  });
  snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(config);
  snapshot.workspaceDir = workspaceDir;
  setCurrentPluginMetadataSnapshot(snapshot, { config, workspaceDir });
  const { registry, createApi } = createRuntimeTestRegistry(createPluginRuntime());
  try {
    const api = createApi(record, { config });
    const tool: AnyAgentTool = {
      ...makeTool("optional_tool"),
      label: "Optional tool",
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };
    runPluginRegisterSyncInRegistry(
      () => api.registerTool(() => tool, { name: tool.name, optional: true }),
      api,
      registry,
      record.id,
    );
    expect(registry.diagnostics).toEqual([]);
    expect(registry.tools).toHaveLength(1);
    const { policy } = resolveConversationCapabilityProfile({ config });
    const tools = resolvePluginTools({
      context: { config, workspaceDir },
      runtimeRegistry: registry,
      toolAllowlist: policy.explicitToolAllowlist,
      toolDenylist: policy.explicitToolDenylist,
    });

    expect(tools.map((selected) => selected.name)).toEqual(expected);
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});
