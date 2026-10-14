import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import { ModelsListResultSchema } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { createModelCatalogDecisions } from "../../agents/model-catalog-decisions.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => cliBackendsTesting.resetDepsForTest());

const reason = "Fixture CLI 1.0 is too old; 2.0 is required. Update its unowned installation.";
const nextCheckAt = 2_000_000_000_000;

it.each([
  { runtime: "fixture-cli", compatible: false },
  { runtime: "fixture-cli", compatible: true },
  { runtime: "fixture-cli", compatible: undefined },
  { runtime: "openclaw", compatible: false },
  { runtime: "openclaw", compatible: true },
])(
  "publishes $runtime compatibility=$compatible with recovery details",
  async ({ runtime, compatible }) => {
    await withOpenClawTestState({ label: "public-cli-compatibility" }, async (state) => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            models: {
              "fixture/new-model": {
                agentRuntime: { id: runtime },
                pickerRuntimes: ["fixture-cli"],
              },
            },
          },
        },
      };
      const backend = {
        id: "fixture-cli",
        modelProvider: "fixture",
        config: { command: "fixture" },
        prepareModelCatalog: async () => {
          throw new Error("Published model reads must not run CLI maintenance");
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.cliBackends.push({ pluginId: "fixture", source: "fixture", backend });
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [{ ...backend, pluginId: "fixture" }],
      });
      const entry = { provider: "fixture", id: "new-model", name: "New model" };
      const snapshot = markPreparedModelCatalogFull({
        entries: [entry],
        routeVariants: [entry],
        ...(compatible === undefined
          ? {}
          : {
              cliRuntimeCompatibility: {
                "fixture-cli": {
                  models: { "new-model": { available: compatible, reason } },
                  nextCheckAt,
                },
              },
            }),
      });
      const projector = createModelCatalogDecisions({
        cfg: config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        snapshot,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "fixture",
              providers: ["fixture"],
              cliBackends: ["fixture-cli"],
              syntheticAuthRefs: ["fixture-cli"],
            },
          ],
        }),
        preparedAuthStore: { version: 1, profiles: {} },
        preparedRuntimeAuthModes: { fixture: "api_key", "fixture-cli": "api_key" },
        preparedSyntheticAuthComplete: true,
        pluginRegistry: registry,
        isCurrent: () => true,
      });
      const result = await buildModelsListResult({
        source: {
          kind: "gateway",
          context: { getRuntimeConfig: () => config } as GatewayRequestContext,
        },
        params: { view: "configured", includeDefaultModels: false },
        preloadedCatalog: { agentId: "main", config, snapshot },
        preloadedOnly: true,
        catalogProjector: projector,
      });
      expect(result.models).toHaveLength(1);
      const model = result.models[0]!;
      const cliChoice = runtime === "fixture-cli" ? model : model.runtimeChoices?.[0];
      expect(cliChoice).toMatchObject({ available: compatible === true });
      if (compatible === true) {
        expect(cliChoice).not.toHaveProperty("runtimeCompatibilityReason");
        expect(cliChoice).not.toHaveProperty("runtimeCompatibilityNextCheckAt");
      } else {
        expect(cliChoice).toMatchObject({
          runtimeCompatibilityReason:
            compatible === undefined
              ? "CLI compatibility has not been verified. Refresh Models to retry."
              : reason,
          ...(compatible === undefined ? {} : { runtimeCompatibilityNextCheckAt: nextCheckAt }),
        });
        expect(cliChoice).not.toHaveProperty("unavailableReason");
        if (compatible === undefined) {
          expect(cliChoice).not.toHaveProperty("runtimeCompatibilityNextCheckAt");
        }
      }
      if (runtime === "openclaw") {
        expect(model.available).toBe(true);
        expect(model).not.toHaveProperty("runtimeCompatibilityReason");
        expect(model).not.toHaveProperty("runtimeCompatibilityNextCheckAt");
      }
      expect(Value.Check(ModelsListResultSchema, result)).toBe(true);
    });
  },
);
