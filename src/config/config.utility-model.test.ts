import { describe, expect, it } from "vitest";
import { shouldSuppressMissingCodexPluginDiagnostics } from "./codex-plugin-diagnostics.js";
import { normalizeSubmittedConfigModelRefs } from "./model-input-normalization.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("utility model configuration", () => {
  it.each([
    {
      utilityModel: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["openai/gpt-5.3-codex-spark"],
      },
      override: undefined,
      warns: true,
    },
    {
      utilityModel: { primary: "openai/gpt-5.3-codex-spark" },
      override: { fallbacks: [] },
      warns: true,
    },
    {
      utilityModel: { fallbacks: ["openai/gpt-5.3-codex-spark"] },
      override: "anthropic/claude-sonnet-4-6",
      warns: false,
    },
    {
      utilityModel: { fallbacks: ["openai/gpt-5.3-codex-spark"] },
      override: { fallbacks: [] },
      warns: false,
    },
    { utilityModel: "openai/gpt-5.3-codex-spark", override: "", warns: false },
  ])("diagnoses effective utility routes for Codex: %j", ({ utilityModel, override, warns }) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
          utilityModel,
        },
        entries: { openclaw: { utilityModel: override } },
      },
    };

    expect(shouldSuppressMissingCodexPluginDiagnostics(config, {})).toBe(!warns);
  });

  it("accepts string and primary/fallback forms without changing their authored shape", () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: {
          utilityModel: { primary: "helper", fallbacks: ["local/backup", "remote/small"] },
        },
        entries: {
          inherited: {},
          shorthand: { utilityModel: "local/small" },
          disabled: { utilityModel: "" },
          primaryOnly: { utilityModel: { primary: "other" } },
          fallbackOnly: { utilityModel: { fallbacks: [] } },
        },
      },
    };

    expect(OpenClawSchema.parse(config).agents).toEqual(config.agents);
  });

  it.each([{ fallbacks: "local/backup" }, { fallbacks: [false] }, { timeoutMs: 1000 }])(
    "rejects malformed or unsupported utility model fields: %j",
    (utilityModel) => {
      for (const agents of [
        { defaults: { utilityModel }, entries: { worker: {} } },
        { entries: { worker: { utilityModel } } },
      ]) {
        expect(OpenClawSchema.safeParse({ agents }).success).toBe(false);
      }
    },
  );

  it("normalizes utility primary and fallback refs through the shared config writer policy", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          utilityModel: { primary: " helper ", fallbacks: [" google/gemini-3-pro-preview "] },
        },
        entries: {
          worker: { utilityModel: { fallbacks: [" together/moonshotai/Kimi-K2.5 "] } },
          disabled: { utilityModel: "" },
        },
      },
    };

    expect(normalizeSubmittedConfigModelRefs(config).agents).toEqual({
      defaults: {
        utilityModel: { primary: "helper", fallbacks: ["google/gemini-3.1-pro-preview"] },
      },
      entries: {
        worker: { utilityModel: { fallbacks: ["together/moonshotai/Kimi-K2.6"] } },
        disabled: { utilityModel: "" },
      },
    });
  });
});
