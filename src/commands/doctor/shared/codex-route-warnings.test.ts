import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectCodexRouteWarnings, maybeRepairCodexRoutes } from "./codex-route-warnings.js";

describe("collectCodexRouteWarnings", () => {
  it("warns when openai-codex primary models still use the legacy route", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([expect.stringContaining("Legacy `openai-codex/*`")]);
    expect(warnings[0]).toContain("agents.defaults.model");
    expect(warnings[0]).toContain("openai/gpt-5.5");
    expect(warnings[0]).toContain('runtime is "pi"');
    expect(warnings[0]).toContain('agentRuntime.id: "auto"');
  });

  it("still warns when the native Codex runtime is selected with a legacy model ref", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
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

    expect(warnings).toEqual([expect.stringContaining("openai/gpt-5.5")]);
    expect(warnings[0]).toContain('runtime is "codex"');
  });

  it("still warns when OPENCLAW_AGENT_RUNTIME selects native Codex with a legacy model ref", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
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

    expect(warnings).toEqual([expect.stringContaining('runtime is "codex"')]);
  });

  it("does not warn for canonical OpenAI refs", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });

  it("repairs defaults and agent overrides to canonical OpenAI refs with runtime auto", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.5",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
            models: {
              "openai-codex/gpt-5.5": { alias: "codex" },
            },
          },
          list: [
            {
              id: "worker",
              model: "openai-codex/gpt-5.4",
              agentRuntime: { id: "codex" },
            },
          ],
        },
      } as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([expect.stringContaining("Repaired Codex model routes")]);
    expect(result.cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "auto" });
    expect(result.cfg.agents?.defaults?.models).toMatchObject({
      "openai-codex/gpt-5.5": { alias: "codex" },
      "openai/gpt-5.5": { alias: "codex" },
      "openai/gpt-5.4": {},
    });
    expect(result.cfg.agents?.list?.[0]).toMatchObject({
      id: "worker",
      model: "openai/gpt-5.4",
      agentRuntime: { id: "auto" },
    });
  });
});
