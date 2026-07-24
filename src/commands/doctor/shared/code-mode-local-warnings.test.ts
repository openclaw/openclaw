import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectCodeModeLocalWarnings } from "./code-mode-local-warnings.js";

describe("collectCodeModeLocalWarnings", () => {
  it("warns when code mode is enabled and primary model is local", () => {
    const warnings = collectCodeModeLocalWarnings({
      tools: { codeMode: { enabled: true } },
      agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.6-35b-a3b" } } },
    } as OpenClawConfig);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Code mode is enabled");
    expect(warnings[0]).toContain("docs.openclaw.ai/tools/code-mode");
  });

  it("warns when code mode is enabled and modelPolicy allowlists local providers", () => {
    const warnings = collectCodeModeLocalWarnings({
      tools: { codeMode: true },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          modelPolicy: { allow: ["openai/gpt-5.5", "ollama/gemma4:latest"] },
        },
      },
    } as OpenClawConfig);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/shell strings|local model/i);
  });

  it("stays quiet when code mode is off", () => {
    expect(
      collectCodeModeLocalWarnings({
        tools: { codeMode: { enabled: false } },
        agents: { defaults: { model: { primary: "ollama/gemma4:latest" } } },
      } as OpenClawConfig),
    ).toEqual([]);
  });

  it("stays quiet when code mode is on but no local providers are configured", () => {
    expect(
      collectCodeModeLocalWarnings({
        tools: { codeMode: { enabled: true } },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: { allow: ["openai/gpt-5.5", "anthropic/claude-sonnet-5"] },
          },
        },
      } as OpenClawConfig),
    ).toEqual([]);
  });
});
