/** Verifies primary provider model selection across plugin model metadata. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyPrimaryModel } from "./provider-model-primary.js";

describe("applyPrimaryModel", () => {
  it("normalizes retired Gemini allowlist keys before writing the primary", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "gemini",
              params: { thinking: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyPrimaryModel(cfg, "google/gemini-3-pro-preview");

    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "gemini",
        params: { thinking: "high" },
      },
    });
  });
});

describe("applyPrimaryModel", () => {
  it("normalizes a preserved retired Google Gemini primary", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-pro-preview" },
        },
      },
    } as OpenClawConfig;
    const next = applyPrimaryModel(config, "openrouter/auto", {
      preserveExistingPrimary: true,
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
  });

  it("preserves an existing primary and keeps fallbacks", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    } as OpenClawConfig;
    const next = applyPrimaryModel(config, "openrouter/auto", {
      preserveExistingPrimary: true,
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "openrouter/auto": {},
    });
  });

  it("normalizes retired Google Gemini default models before writing config", () => {
    const config = {
      agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": {} } } },
    } as OpenClawConfig;
    const next = applyPrimaryModel(config, "google/gemini-3-pro-preview");
    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
    expect(next.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": {},
      "google/gemini-3.1-pro-preview": {},
    });
  });

  it("normalizes existing retired Google Gemini model keys before writing defaults", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {
              alias: "gemini",
              params: { thinking: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyPrimaryModel(config, "google/gemini-3.1-pro-preview");

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "gemini",
        params: { thinking: "high" },
      },
    });
  });

  it("normalizes retired Google Gemini fallbacks when writing config", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;
    const next = applyPrimaryModel(config, "openrouter/auto");
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openrouter/auto",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
  });
});
