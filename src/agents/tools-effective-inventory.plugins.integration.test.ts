import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { appendDeclaredPluginToolAccess } from "./tool-access-diagnostics.plugins.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  clearPluginMetadataLifecycleCaches();
});

it("completes the preview with manifest-only explanations for unconstructed tools", async () => {
  await withOpenClawTestState(
    {
      prefix: "tool-diagnostics-",
      layout: "split",
      prepareProfileCatalog: true,
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const runtimeMarker = state.path("runtime-loaded");
      const entry = await state.writeText(
        "plugin/index.cjs",
        `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded");
throw new Error("Diagnostic must not load plugin runtime");`,
      );
      await state.writeJson("plugin/openclaw.plugin.json", {
        id: "fixture-tools",
        contracts: { tools: ["fixture_lookup", "fixture_optional"] },
        toolMetadata: {
          fixture_lookup: {
            configSignals: [
              { rootPath: "plugins.entries.fixture-tools.config", required: ["apiKey"] },
            ],
          },
          fixture_optional: {
            optional: true,
            configSignals: [
              { rootPath: "plugins.entries.fixture-tools.config", required: ["apiKey"] },
            ],
          },
        },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      });
      const baseConfig: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        plugins: { allow: ["fixture-tools"], load: { paths: [entry] }, slots: { memory: "none" } },
      };
      const metadataSnapshot = resolvePluginMetadataSnapshot({
        config: baseConfig,
        workspaceDir: state.workspaceDir,
      });
      // Explaining declarations alone must not import a runtime. The full preview below
      // retains normal tool-construction behavior, which may inspect plugin modules.
      appendDeclaredPluginToolAccess({
        diagnostics: { checked: "live-session", profiles: [], tools: [] },
        config: baseConfig,
        capabilityProfile: resolveConversationCapabilityProfile({
          config: baseConfig,
          pluginMetadataSnapshot: metadataSnapshot,
        }),
        metadataSnapshot,
      });
      expect(fs.existsSync(runtimeMarker)).toBe(false);
      for (const [tools, expected] of [
        [
          { profile: "coding" },
          { status: "excluded", reasons: [{ kind: "profile", source: "tools.profile" }] },
        ],
        [
          { profile: "full", byProvider: { openai: { profile: "coding" } } },
          {
            status: "excluded",
            reasons: [{ kind: "profile", source: 'tools.byProvider["openai"].profile' }],
          },
        ],
        [
          { profile: "coding", allow: ["fixture-tools"] },
          { status: "excluded", reasons: [{ kind: "profile", source: "tools.profile" }] },
        ],
        [
          { profile: "coding", deny: ["fixture-tools"] },
          { status: "excluded", reasons: [{ kind: "deny", source: "tools.deny" }] },
        ],
        [
          { profile: "full", deny: ["group:plugins"] },
          { status: "excluded", reasons: [{ kind: "deny", source: "tools.deny" }] },
        ],
        [
          {},
          {
            status: "unavailable",
            reasons: [
              {
                kind: "runtime",
                label: expect.stringContaining("runtime health are not confirmed"),
              },
            ],
          },
        ],
      ] satisfies [OpenClawConfig["tools"], object][]) {
        const cfg: OpenClawConfig = {
          ...baseConfig,
          tools,
        };
        const context = { config: cfg, env: process.env, workspaceDir: state.workspaceDir };
        const snapshot = resolvePluginMetadataSnapshot(context);
        setGatewayPluginMetadataSnapshot(snapshot, context);
        const result = await resolveEffectiveToolInventory({
          cfg,
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(),
          modelApi: null,
          modelProvider: "openai",
          conversationCapabilityProfile: resolveConversationCapabilityProfile({
            config: cfg,
            modelProvider: "openai",
            pluginMetadataSnapshot: snapshot,
          }),
        });
        expect(
          result.groups
            .flatMap((group) => group.tools)
            .some((tool) => tool.id === "fixture_lookup"),
        ).toBe(false);
        expect(result.toolAccess?.tools.find((tool) => tool.id === "fixture_lookup")).toMatchObject(
          expected,
        );
        expect(
          result.toolAccess?.tools.find((tool) => tool.id === "fixture_optional"),
        ).toMatchObject(expected);
      }
    },
  );
});
