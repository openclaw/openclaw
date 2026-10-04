import { describe, expect, it } from "vitest";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { applySystemAgentModelSelection } from "./setup-model-selection.js";

describe("applySystemAgentModelSelection", () => {
  it.each([false, true])(
    "adds a utility without changing other bindings (first run: %s)",
    async (firstRun) => {
      const config: OpenClawConfig = firstRun
        ? {}
        : {
            agents: {
              defaults: {
                systemAgent: { agentId: "main" },
                model: {
                  primary: "openai/gpt-5.5@openai:primary",
                  fallbacks: ["openai/gpt-5.4@openai:backup"],
                },
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              },
              entries: {
                main: { agentDir: "/tmp/main-auth" },
                ops: { model: "openai/gpt-5.4" },
              },
            },
            auth: {
              profiles: {
                "openai:primary": { provider: "openai", mode: "api_key" },
                "openai:utility": { provider: "openai", mode: "api_key" },
              },
              order: { openai: ["openai:primary", "openai:utility"] },
            },
          };
      const original = structuredClone(config);

      const result = await applySystemAgentModelSelection({
        config,
        model: firstRun ? "local-utility/tiny" : "openai/gpt-5.5",
        modelTarget: "utility",
        authProfileId: firstRun ? undefined : "openai:utility",
      });

      expect(result.agents?.defaults).toEqual({
        ...config.agents?.defaults,
        utilityModel: firstRun ? "local-utility/tiny" : "openai/gpt-5.5@openai:utility",
      });
      expect(result.agents?.entries).toEqual(config.agents?.entries);
      expect(result.auth).toEqual(config.auth);
      expect(config).toEqual(original);
      if (firstRun) {
        expect(result.agents?.defaults?.model).toBeUndefined();
        expect(result.meta?.migrations?.utilityModelSeparation).toBe(true);
      }
    },
  );

  it.each([
    { targetAgentId: "ops", priorUtility: undefined },
    { targetAgentId: undefined, priorUtility: "local-utility/old" },
    { targetAgentId: undefined, priorUtility: "" },
    { targetAgentId: undefined, priorUtility: undefined, ownership: "explicit" as const },
  ])("writes a utility selection only to its agent owner: %j", async (scenario) => {
    const config: OpenClawConfig = {
      agents: {
        ...(scenario.ownership ? { ownership: scenario.ownership } : {}),
        defaults: {
          systemAgent: { agentId: "ops" },
          model: "openai/gpt-5.5",
          utilityModel: "local-utility/shared",
        },
        entries: {
          main: {},
          ops: {
            model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.5"] },
            agentDir: "/tmp/ops-auth",
            ...(scenario.priorUtility !== undefined ? { utilityModel: scenario.priorUtility } : {}),
          },
        },
      },
    };

    const result = await applySystemAgentModelSelection({
      config,
      model: "local-utility/tiny",
      modelTarget: "utility",
      targetAgentId: scenario.targetAgentId,
    });

    expect(result.agents?.defaults).toEqual(config.agents?.defaults);
    expect(result.agents?.entries?.main).toEqual(config.agents?.entries?.main);
    expect(result.agents?.entries?.ops).toEqual({
      ...config.agents?.entries?.ops,
      utilityModel: "local-utility/tiny",
      models: { "local-utility/tiny": {} },
    });
  });

  it("keeps a newly approved model allowed when migrating a first-run legacy model map", async () => {
    const cfg = await applySystemAgentModelSelection({
      config: { agents: { defaults: { models: { "fixture/old": {} } } } },
      model: "fixture/new",
      agentRuntimeId: "openclaw",
      runtimeInDefaults: true,
    });
    const allowed = buildAllowedModelSet({ cfg, catalog: [], defaultProvider: "fixture" });
    expect(allowed.allows({ provider: "fixture", model: "new" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "old" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "unapproved" })).toBe(false);
  });

  it("rejects an unrepresentable explicit agent instead of updating main", async () => {
    const config = {
      agents: {
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    await expect(
      applySystemAgentModelSelection({
        config,
        model: "openai/gpt-5.5",
        targetAgentId: "агент✨",
      }),
    ).rejects.toThrow('Could not resolve configured agent "агент✨".');
    expect(config.agents.entries.main).toEqual({});
  });

  it.each(["system owner", "native runtime", "verified credential"] as const)(
    "updates the primary selection for %s without changing unrelated bindings",
    async (scenario) => {
      const config: OpenClawConfig =
        scenario === "system owner"
          ? createCanonicalAgentConfigFixture({
              agents: {
                defaults: { systemAgent: { agentId: "beta" } },
                entries: {
                  alpha: { default: true, model: "openai/gpt-5.5" },
                  beta: { model: "openai/gpt-5.6-sol" },
                },
              },
            }).config
          : scenario === "native runtime"
            ? {
                agents: {
                  defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
                  entries: {
                    work: {
                      model: "openai/gpt-5.5",
                      models: {
                        "openai/gpt-5.5": { alias: "primary", agentRuntime: { id: "codex" } },
                      },
                    },
                  },
                },
              }
            : { agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: {} } } };
      const result = await applySystemAgentModelSelection({
        config,
        model: scenario === "system owner" ? "openai/gpt-5.6-luna" : "openai/gpt-5.5",
        authProfileId: scenario === "verified credential" ? "openai:verified" : undefined,
      });
      if (scenario === "system owner") {
        expect(result.agents?.entries?.alpha?.model).toBe("openai/gpt-5.5");
        expect(result.agents?.entries?.beta?.model).toBe("openai/gpt-5.6-luna");
      } else if (scenario === "native runtime") {
        expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
        expect(result.agents?.entries?.work?.models?.["openai/gpt-5.5"]).toEqual({
          alias: "primary",
        });
        expect(result.agents?.entries?.work?.model).toBe("openai/gpt-5.5");
      } else {
        expect(result.agents?.defaults?.model).toBe("openai/gpt-5.5@openai:verified");
        expect(result.agents?.defaults?.models).toBeUndefined();
      }
    },
  );
});
