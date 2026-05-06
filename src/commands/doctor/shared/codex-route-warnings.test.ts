import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectCodexRouteWarnings } from "./codex-route-warnings.js";

function codexPluginConfig(): Pick<OpenClawConfig, "plugins"> {
  return {
    plugins: {
      entries: {
        codex: { enabled: true },
      },
    },
  } as Pick<OpenClawConfig, "plugins">;
}

describe("collectCodexRouteWarnings", () => {
  it("leaves openai-codex model refs unchanged in normal warning collection", () => {
    const cfg = {
      ...codexPluginConfig(),
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.5",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as OpenClawConfig;
    const before = structuredClone(cfg);

    collectCodexRouteWarnings({ cfg });

    expect(cfg).toEqual(before);
  });

  it("accepts native Codex as openai/gpt-5.5 plus agentRuntime.id=codex", () => {
    const cfg = {
      ...codexPluginConfig(),
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai-codex/gpt-5.5"],
          },
          agentRuntime: { id: "codex" },
        },
      },
    } as OpenClawConfig;

    const warnings = collectCodexRouteWarnings({ cfg });

    expect(warnings).toEqual([]);
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai-codex/gpt-5.5"],
    });
  });

  it("warns when the Codex plugin is enabled but openai-codex models still route through PI", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        ...codexPluginConfig(),
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([expect.stringContaining("Codex plugin is enabled")]);
    expect(warnings[0]).toContain("agents.defaults.model");
    expect(warnings[0]).toContain('runtime "pi"');
    expect(warnings[0]).toContain('agentRuntime.id: "codex"');
  });

  it("does not warn when the native Codex runtime is selected", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        ...codexPluginConfig(),
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            agentRuntime: {
              id: "codex",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });

  it("does not warn when OPENCLAW_AGENT_RUNTIME selects native Codex", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        ...codexPluginConfig(),
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_AGENT_RUNTIME: "codex",
      },
    });

    expect(warnings).toEqual([]);
  });

  it("does not warn unless the Codex plugin is explicitly enabled or allowed", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });
});
