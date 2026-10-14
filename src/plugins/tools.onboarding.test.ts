import { afterEach, expect, it } from "vitest";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { applyLocalSetupWorkspaceConfig } from "../commands/onboard-config.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { resolvePluginTools } from "./tools.js";

afterEach(() => setCurrentPluginMetadataSnapshot(undefined));

it.each([
  { deny: [], expected: ["optional_tool"] },
  { deny: ["optional_tool"], expected: [] },
])(
  "selects optional tools after local onboarding while honoring deny=$deny",
  async ({ deny, expected }) => {
    const workspaceDir = "/tmp";
    const config = applyLocalSetupWorkspaceConfig(
      {
        plugins: {
          enabled: true,
          load: { paths: ["/tmp/plugin.js"] },
          slots: { memory: "none" },
        },
        tools: { deny },
      },
      workspaceDir,
    );
    const artifact = {
      source: "/tmp/optional-demo.js",
      rootDir: workspaceDir,
      origin: "bundled" as const,
      preferBuiltPluginArtifacts: false,
    };
    const record = createPluginRecord({
      id: "optional-demo",
      ...artifact,
      enabled: true,
      configSchema: true,
      contracts: { tools: ["optional_tool"] },
    });
    bindPluginRuntimeArtifactSelection(record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
    });
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: record.id,
          ...artifact,
          enabledByDefault: true,
          contracts: record.contracts,
          toolMetadata: { optional_tool: { optional: true } },
        },
      ],
    });
    snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    snapshot.workspaceDir = workspaceDir;
    setCurrentPluginMetadataSnapshot(snapshot, { config, workspaceDir });
    const { registry, createApi } = createTestPluginRegistry(createPluginRuntime());
    registry.plugins.push(record);
    try {
      const api = createApi(record, { config });
      runPluginRegisterSyncInRegistry(
        () =>
          api.registerTool(
            () => ({
              name: "optional_tool",
              label: "Optional tool",
              description: "optional_tool tool",
              parameters: { type: "object", properties: {} },
              async execute() {
                return { content: [{ type: "text", text: "ok" }], details: {} };
              },
            }),
            { name: "optional_tool", optional: true },
          ),
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

      expect(tools.map((tool) => tool.name)).toEqual(expected);
    } finally {
      await disposePluginRegistryInstances(registry);
    }
  },
);
