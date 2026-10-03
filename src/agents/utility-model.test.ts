import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import {
  resolveAutomaticUtilityRuntimeOverride,
  resolveConfiguredSetupModelForAgent,
  resolveUtilityModelRefForAgent,
} from "./utility-model.js";

function snapshotWithDefaults(defaults: Record<string, string>) {
  return createPluginMetadataSnapshotFixture({
    plugins: Object.entries(defaults).map(([provider, defaultUtilityModel], index) => ({
      id: `plugin-${index}`,
      modelCatalog: {
        providers: { [provider]: { defaultUtilityModel, models: [{ id: defaultUtilityModel }] } },
      },
    })),
  });
}

describe("resolveConfiguredSetupModelForAgent", () => {
  it.each([
    { utilityModel: undefined, expected: undefined },
    { utilityModel: "", expected: undefined },
    {
      utilityModel: "local-utility/shared",
      agentId: "ops",
      expected: { modelRef: "local-utility/ops", modelTarget: "utility" },
    },
    { utilityModel: "local-utility/shared", agentId: "disabled", expected: undefined },
    {
      utilityModel: " local-utility/tiny@local-utility:setup ",
      expected: { modelRef: "local-utility/tiny@local-utility:setup", modelTarget: "utility" },
    },
  ])(
    "uses only an enabled utility setting for setup: %j",
    ({ utilityModel, expected, agentId = "main" }) => {
      const cfg: OpenClawConfig = {
        meta: { migrations: { utilityModelSeparation: true } },
        agents: {
          defaults: { utilityModel },
          entries: { ops: { utilityModel: "local-utility/ops" }, disabled: { utilityModel: "" } },
        },
      };
      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId })).toEqual(expected);
      cfg.agents!.defaults!.model = "openai/gpt-5.5";
      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId, modelTarget: "utility" })).toEqual(
        expected,
      );
    },
  );

  it.each([false, true])(
    "keeps the native primary for setup unless utility is selected (ACP=%s)",
    (acp) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.5@openai:primary",
            utilityModel: "local-utility/tiny",
          },
          entries: {
            main: acp ? { model: "harness-only", runtime: { type: "acp" } } : {},
          },
        },
      };

      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "main" })).toEqual({
        modelRef: "openai/gpt-5.5@openai:primary",
      });
      expect(
        resolveConfiguredSetupModelForAgent({ cfg, agentId: "main", modelTarget: "utility" }),
      ).toEqual({ modelRef: "local-utility/tiny", modelTarget: "utility" });
    },
  );

  it.each(["local-utility/tiny@local:utility", "helper@local:utility"])(
    "keeps the legacy implicit primary for setup alongside utility ref %s",
    (utilityModel) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            utilityModel,
            models: { "local-utility/tiny": { alias: "helper" } },
          },
        },
        models: {
          providers: {
            "local-utility": {
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                makeProviderModelFixture({
                  id: "tiny",
                  provider: "local-utility",
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:9/v1",
                }),
              ],
            },
          },
        },
      };
      const original = structuredClone(cfg);

      expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "main" })).toEqual({
        modelRef: "local-utility/tiny",
        implicitPrimary: true,
      });
      expect(
        resolveConfiguredSetupModelForAgent({ cfg, agentId: "main", modelTarget: "utility" }),
      ).toEqual({ modelRef: utilityModel, modelTarget: "utility" });
      expect(cfg).toEqual(original);
    },
  );
});

describe("resolveUtilityModelRefForAgent", () => {
  const metadataSnapshot = snapshotWithDefaults({
    openai: "gpt-5.6-luna",
    anthropic: "claude-haiku-4-5",
  });
  type Scenario = {
    name: string;
    cfg: OpenClawConfig;
    agentId?: string;
    primaryProvider?: string;
    primaryModelRef?: string;
    expected?: string;
  };
  it.each<Scenario>([
    {
      name: "trimmed explicit reference",
      cfg: { agents: { defaults: { utilityModel: " openrouter/mistralai/mistral-small " } } },
      expected: "openrouter/mistralai/mistral-small",
    },
    { name: "disabled", cfg: { agents: { defaults: { utilityModel: "   " } } } },
    {
      name: "provider default",
      cfg: { agents: { defaults: { model: "anthropic/claude-fable-5" } } },
      expected: "anthropic/claude-haiku-4-5",
    },
    {
      name: "native auth profile",
      cfg: { agents: { defaults: { model: "openai/gpt-5.5@work" }, entries: { main: {} } } },
      expected: "openai/gpt-5.6-luna@work",
    },
    {
      name: "ACP preserves native auth profile",
      cfg: {
        agents: {
          defaults: { model: "openai/gpt-5.5@work" },
          entries: { main: { model: "harness-only@harness-profile", runtime: { type: "acp" } } },
        },
      },
      expected: "openai/gpt-5.6-luna@work",
    },
    {
      name: "session auth overrides primary",
      cfg: { agents: { defaults: { model: "anthropic/claude-fable-5@personal" } } },
      primaryProvider: "OpenAI",
      primaryModelRef: "openai/gpt-5.5@work",
      expected: "openai/gpt-5.6-luna@work",
    },
    { name: "no provider default", cfg: { agents: { defaults: { model: "ollama/llama-4-70b" } } } },
    {
      name: "agent opt-out",
      cfg: {
        agents: {
          defaults: { utilityModel: "openai/gpt-5.4-mini" },
          list: [{ id: "ops", utilityModel: "" }],
        },
      },
      agentId: "ops",
    },
    {
      name: "other agent retains shared model",
      cfg: {
        agents: {
          defaults: { utilityModel: "openai/gpt-5.4-mini" },
          list: [{ id: "ops", utilityModel: "" }],
        },
      },
      expected: "openai/gpt-5.4-mini",
    },
  ])("resolves $name", ({ expected, agentId = "main", ...params }) => {
    expect(resolveUtilityModelRefForAgent({ ...params, agentId, metadataSnapshot })).toBe(expected);
  });
});

describe("resolveAutomaticUtilityRuntimeOverride", () => {
  const primary = "anthropic/claude-opus-5";
  const utility = "anthropic/claude-haiku-4-5";
  const cliEntry = { agentRuntime: { id: "claude-cli" } };
  const metadataSnapshot = snapshotWithDefaults({ anthropic: "claude-haiku-4-5" });
  type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
  type Scenario = {
    name: string;
    defaults?: Defaults;
    providers?: NonNullable<OpenClawConfig["models"]>["providers"];
    utilityProvider?: string;
    utilityModelId?: string;
    metadataSnapshot?: typeof metadataSnapshot;
    expected?: string;
  };
  it.each<Scenario>([
    { name: "model-level CLI pin", expected: "claude-cli" },
    { name: "explicit same-provider selection", utilityModelId: "claude-sonnet-5" },
    {
      name: "provider without automatic default",
      metadataSnapshot: snapshotWithDefaults({ openai: "gpt-5.4-mini" }),
    },
    { name: "explicit utility setting", defaults: { utilityModel: "openai/gpt-5.6-luna" } },
    { name: "disabled utility setting", defaults: { utilityModel: "" } },
    { name: "different provider", utilityProvider: "openai", utilityModelId: "gpt-5.6-luna" },
    { name: "default primary runtime", defaults: { models: {} } },
    {
      name: "provider-level runtime",
      defaults: { models: {} },
      providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [], ...cliEntry } },
    },
    { name: "wildcard runtime", defaults: { models: { "anthropic/*": cliEntry } } },
    {
      name: "derived HTTP pin",
      defaults: {
        models: { [primary]: cliEntry, [utility]: { agentRuntime: { id: "openclaw" } } },
      },
    },
    {
      name: "bare derived entry",
      defaults: { models: { [primary]: cliEntry, [utility]: {} } },
      expected: "claude-cli",
    },
    {
      name: "derived default alias",
      defaults: { models: { [primary]: cliEntry, [utility]: { agentRuntime: { id: "default" } } } },
      expected: "claude-cli",
    },
  ])(
    "inherits only an automatic model's eligible runtime: $name",
    ({ defaults, providers, expected, ...scenario }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: primary, models: { [primary]: cliEntry }, ...defaults } },
        ...(providers ? { models: { providers } } : {}),
      };
      expect(
        resolveAutomaticUtilityRuntimeOverride({
          cfg,
          agentId: "main",
          utilityProvider: "anthropic",
          utilityModelId: "claude-haiku-4-5",
          metadataSnapshot,
          ...scenario,
        }),
      ).toBe(expected);
    },
  );
});
