import { fileURLToPath } from "node:url";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, onTestFinished } from "vitest";
import codexPlugin from "../../extensions/codex/index.js";
import {
  dualRoutes,
  routeResolverFactory,
} from "../../src/agents/model-auth-availability.test-support.js";
import { createModelCatalogDecisions } from "../../src/agents/model-catalog-decisions.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

describe("registered Codex runtime choices", () => {
  it.each(["api_key", "oauth", "token"] as const)(
    "keeps native %s authentication with its registered harness",
    async (mode) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "native-choice-" },
        async (state) => {
          const config: OpenClawConfig = {
            plugins: { entries: { codex: { enabled: true } } },
            agents: {
              defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
            },
          };
          const registry = createEmptyPluginRegistry();
          codexPlugin.register(
            createTestPluginApi({
              id: "codex",
              rootDir: fileURLToPath(new URL("../../extensions/codex/", import.meta.url)),
              config,
              runtime: createPluginRuntimeMock({ config: { current: () => config } }),
              registerAgentHarness: (harness) => {
                registry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
                onTestFinished(() => harness.dispose?.());
              },
            }),
          );
          const entry = { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" };
          const params = {
            cfg: config,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            snapshot: { entries: [entry], routeVariants: [entry] },
            metadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
            }),
            preparedAuthStore: { version: 1, profiles: {} },
            preparedSyntheticAuthComplete: true,
            pluginRegistry: registry,
            isCurrent: () => true,
            routeResolverFactory: routeResolverFactory(dualRoutes),
          };
          const owner = createModelCatalogDecisions({
            ...params,
            preparedRuntimeAuthModes: { codex: { source: "native", mode } },
          });

          expect(await owner.runtimeChoices(entry)).toEqual(["codex"]);
          expect(
            await createModelCatalogDecisions({
              ...params,
              preparedRuntimeAuthModes: {},
            }).runtimeChoices(entry),
          ).toEqual([]);
        },
      );
    },
  );
});
