// Utility-model resolution tests cover explicit/disabled/auto settings and
// provider-declared default derivation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { readUtilityModelSetting } from "./utility-model-setting.js";
import {
  resolveAutomaticUtilityRuntimeOverride,
  resolveConfiguredSetupModelForAgent,
  resolveUtilityModelRefForAgent,
} from "./utility-model.js";

function snapshotWithDefaults(defaults: Record<string, string>): PluginMetadataSnapshot {
  const plugins = Object.entries(defaults).map(([provider, defaultUtilityModel], index) => ({
    id: `plugin-${index}`,
    modelCatalog: {
      providers: {
        [provider]: { defaultUtilityModel, models: [{ id: defaultUtilityModel }] },
      },
    },
  }));
  return { plugins } as unknown as PluginMetadataSnapshot;
}

describe("readUtilityModelSetting", () => {
  it("distinguishes unset, explicit, and empty-string disable", () => {
    expect(readUtilityModelSetting({} as OpenClawConfig, "main")).toEqual({ kind: "auto" });
    expect(
      readUtilityModelSetting(
        { agents: { defaults: { utilityModel: " openai/gpt-5.4-mini " } } } as OpenClawConfig,
        "main",
      ),
    ).toEqual({ kind: "explicit", modelRef: "openai/gpt-5.4-mini" });
    expect(
      readUtilityModelSetting(
        { agents: { defaults: { utilityModel: "" } } } as OpenClawConfig,
        "main",
      ),
    ).toEqual({ kind: "disabled" });
    expect(
      readUtilityModelSetting(
        { agents: { defaults: { utilityModel: "   " } } } as OpenClawConfig,
        "main",
      ),
    ).toEqual({ kind: "disabled" });
  });

  it("lets an agent-level empty string disable a defaults-level model", () => {
    const cfg = {
      agents: {
        defaults: { utilityModel: "openai/gpt-5.4-mini" },
        list: [{ id: "ops", utilityModel: "" }],
      },
    } as OpenClawConfig;

    expect(readUtilityModelSetting(cfg, "ops")).toEqual({ kind: "disabled" });
    expect(readUtilityModelSetting(cfg, "main")).toEqual({
      kind: "explicit",
      modelRef: "openai/gpt-5.4-mini",
    });
  });
});

describe("resolveConfiguredSetupModelForAgent", () => {
  it.each([
    { utilityModel: undefined, expected: undefined },
    { utilityModel: "", expected: undefined },
    { utilityModel: "   ", expected: undefined },
    {
      utilityModel: " local-utility/tiny@local-utility:setup ",
      expected: { modelRef: "local-utility/tiny@local-utility:setup", modelTarget: "utility" },
    },
  ])("uses only an explicitly enabled utility model for first-run setup: %j", (scenario) => {
    const cfg: OpenClawConfig = {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: { defaults: { utilityModel: scenario.utilityModel } },
    };

    expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "main" })).toEqual(
      scenario.expected,
    );
  });

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

  it.each([undefined, "", "   "])(
    "does not fall back to a primary or automatic utility during utility verification: %j",
    (utilityModel) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "openai/gpt-5.5", utilityModel } },
      };

      expect(
        resolveConfiguredSetupModelForAgent({ cfg, agentId: "main", modelTarget: "utility" }),
      ).toBeUndefined();
    },
  );

  it("honors an agent's utility override and opt-out over the shared setup model", () => {
    const cfg: OpenClawConfig = {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        defaults: { utilityModel: "local-utility/shared" },
        entries: { ops: { utilityModel: "local-utility/ops" }, disabled: { utilityModel: "" } },
      },
    };

    expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "ops" })).toEqual({
      modelRef: "local-utility/ops",
      modelTarget: "utility",
    });
    expect(resolveConfiguredSetupModelForAgent({ cfg, agentId: "disabled" })).toBeUndefined();
  });

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

  it("passes explicit config through untouched", () => {
    const cfg = {
      agents: { defaults: { utilityModel: "openrouter/mistralai/mistral-small" } },
    } as OpenClawConfig;

    expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
      "openrouter/mistralai/mistral-small",
    );
  });

  it("returns undefined when utility routing is disabled", () => {
    const cfg = { agents: { defaults: { utilityModel: "" } } } as OpenClawConfig;

    expect(
      resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot }),
    ).toBeUndefined();
  });

  it("derives the provider default from the agent's primary model", () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-fable-5" } },
    } as OpenClawConfig;

    expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it.each([false, true])(
    "carries the native primary auth profile onto the utility default (ACP=%s)",
    (acp) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.5@work" },
          entries: {
            main: acp ? { model: "harness-only@harness-profile", runtime: { type: "acp" } } : {},
          },
        },
      };

      expect(resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot })).toBe(
        "openai/gpt-5.6-luna@work",
      );
    },
  );

  it("prefers caller-resolved session provider and profile context", () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-fable-5@personal" } },
    } as OpenClawConfig;

    expect(
      resolveUtilityModelRefForAgent({
        cfg,
        agentId: "main",
        primaryProvider: "OpenAI",
        primaryModelRef: "openai/gpt-5.5@work",
        metadataSnapshot,
      }),
    ).toBe("openai/gpt-5.6-luna@work");
  });

  it("returns undefined for providers without a declared default", () => {
    const cfg = {
      agents: { defaults: { model: "ollama/llama-4-70b" } },
    } as OpenClawConfig;

    expect(
      resolveUtilityModelRefForAgent({ cfg, agentId: "main", metadataSnapshot }),
    ).toBeUndefined();
  });
});

describe("resolveAutomaticUtilityRuntimeOverride", () => {
  // The primary pins a CLI runtime on its own model entry, so the derived small
  // model matches no entry and would otherwise take the default HTTP auth path.
  const cliPrimary = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-5",
        models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  } as OpenClawConfig;
  // Inheritance is scoped to the manifest-declared automatic utility model, so
  // every case states that declaration instead of relying on ambient plugin state.
  const metadataSnapshot = snapshotWithDefaults({ anthropic: "claude-haiku-4-5" });

  it("inherits the primary's model-level runtime for an auto-derived utility model", () => {
    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg: cliPrimary,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot,
      }),
    ).toBe("claude-cli");
  });

  it("leaves an explicitly selected same-provider model on its own route", () => {
    // Selection prefers a caller-supplied modelRef over automatic derivation, so
    // provider equality alone would move a model that already routes over HTTP
    // onto the primary's CLI subscription quota.
    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg: cliPrimary,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-sonnet-5",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  it("does not inherit when the provider declares no automatic utility model", () => {
    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg: cliPrimary,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot: snapshotWithDefaults({ openai: "gpt-5.4-mini" }),
      }),
    ).toBeUndefined();
  });

  it.each([
    { label: "explicit", utilityModel: "openai/gpt-5.6-luna" },
    { label: "disabled", utilityModel: "" },
  ])("does not inherit when utilityModel is $label", ({ utilityModel }) => {
    const cfg = {
      agents: { defaults: { ...cliPrimary.agents?.defaults, utilityModel } },
    } as OpenClawConfig;

    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  it("does not inherit across providers", () => {
    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg: cliPrimary,
        agentId: "main",
        utilityProvider: "openai",
        utilityModelId: "gpt-5.6-luna",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  it("leaves a primary on the default runtime alone", () => {
    const cfg = { agents: { defaults: { model: "anthropic/claude-opus-5" } } } as OpenClawConfig;

    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  it("does not inherit a provider-level runtime", () => {
    // A provider-level agentRuntime already applies to every model of that
    // provider, so the derived ref resolves it without help.
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-5" } },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [],
            agentRuntime: { id: "claude-cli" },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  it("skips inheritance when the derived model already resolves its own runtime", () => {
    // A provider-wildcard entry already covers the derived ref, so the harness
    // policy resolves it directly and no override is needed.
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-5",
          models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  // A runtime named on the derived model's own entry wins outright, so an
  // operator can pin these completions to the HTTP route even on a host with no
  // provider credential, where the credential gate would otherwise inherit.
  it("keeps the derived model on HTTP when its own entry pins the default runtime", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-5",
          models: {
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-haiku-4-5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAutomaticUtilityRuntimeOverride({
        cfg,
        agentId: "main",
        utilityProvider: "anthropic",
        utilityModelId: "claude-haiku-4-5",
        metadataSnapshot,
      }),
    ).toBeUndefined();
  });

  // The boundary of that pin, stated so it cannot be documented loosely: an
  // entry only counts when it names a runtime. A bare entry, and an
  // `agentRuntime.id` that normalizes back to the default, both still inherit.
  it("still inherits when the derived entry names no non-default runtime", () => {
    const withEntry = (haiku: Record<string, unknown>) =>
      ({
        agents: {
          defaults: {
            model: "anthropic/claude-opus-5",
            models: {
              "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
              "anthropic/claude-haiku-4-5": haiku,
            },
          },
        },
      }) as OpenClawConfig;

    for (const cfg of [withEntry({}), withEntry({ agentRuntime: { id: "default" } })]) {
      expect(
        resolveAutomaticUtilityRuntimeOverride({
          cfg,
          agentId: "main",
          utilityProvider: "anthropic",
          utilityModelId: "claude-haiku-4-5",
          metadataSnapshot,
        }),
      ).toBe("claude-cli");
    }
  });
});
