// Exercises /models through the published catalog and the real runtime-choice owner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { buildPreparedModelsProviderData } from "./commands-models.js";
import { createModelsTestOwner } from "./commands-models.test-support.js";

const CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "github-copilot/fixture-model" },
      models: { "github-copilot/fixture-model": { agentRuntime: { id: "openclaw" } } },
    },
  },
  plugins: { entries: { copilot: { enabled: true } } },
};

beforeEach(() => {
  // No CLI backends: the alternate runtime must come from the app-server binding.
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
  vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    (params = {}) => {
      const config = params.config ?? CONFIG;
      const entries = [{ provider: "github-copilot", id: "fixture-model", name: "Fixture Model" }];
      const registry = createEmptyPluginRegistry();
      if (config.plugins?.entries?.copilot?.enabled !== false) {
        registry.agentHarnesses.push({
          pluginId: "copilot",
          source: "fixture",
          harness: {
            id: "copilot",
            label: "GitHub Copilot",
            supports: () => ({ supported: true }),
            async runAttempt() {
              throw new Error("Browsing must not execute a model");
            },
          },
        });
      }
      const owner = {
        ...createModelsTestOwner(config, entries, params),
        pluginRegistry: registry,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "github-copilot", providers: ["github-copilot"] }, { id: "copilot" }],
        }),
      };
      setPreparedModelRuntimeAuthStore(owner, {
        version: 1,
        profiles: {
          "github-copilot:fixture": {
            type: "token",
            provider: "github-copilot",
            token: "fixture-token",
          },
        },
      });
      return owner;
    },
  );
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
});

describe("buildPreparedModelsProviderData app-server runtime choices", () => {
  it("offers Copilot for an authenticated model even when OpenClaw is its configured default", async () => {
    const data = await buildPreparedModelsProviderData(CONFIG);
    const choices = data.runtimeChoicesByModel?.get("github-copilot/fixture-model");
    expect(choices?.map((choice) => choice.id)).toEqual(["openclaw", "copilot"]);
    expect(choices?.find((choice) => choice.id === "copilot")).toMatchObject({
      label: "GitHub Copilot",
      description: "Use the GitHub Copilot runtime selected by the effective harness policy.",
    });
    expect(data.runtimeChoicesByProvider?.get("github-copilot")).toEqual(choices);
  });

  it("does not offer an app-server runtime absent from the published enabled registry", async () => {
    const data = await buildPreparedModelsProviderData({
      ...CONFIG,
      plugins: { entries: { copilot: { enabled: false } } },
    });
    expect(
      data.runtimeChoicesByModel?.get("github-copilot/fixture-model")?.map((choice) => choice.id),
    ).toEqual(["openclaw"]);
  });
});
