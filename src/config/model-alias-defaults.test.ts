import { describe, expect, it } from "vitest";
import { applyLoggingDefaults, applyModelAliasDefaults } from "./defaults.js";
import type { ClawdbotConfig } from "./types.js";

describe("applyModelAliasDefaults", () => {
  it("adds default shorthands", () => {
    const cfg = { agent: {} } satisfies ClawdbotConfig;
    const next = applyModelAliasDefaults(cfg);

    expect(next.agent?.modelAliases).toEqual({
      opus: "anthropic/claude-opus-4-5",
      sonnet: "anthropic/claude-sonnet-4-5",
      gpt: "openai/gpt-5.2",
      "gpt-mini": "openai/gpt-5-mini",
      gemini: "google/gemini-3-pro-preview",
      "gemini-flash": "google/gemini-3-flash-preview",
    });
  });

  it("normalizes casing when alias matches the default target", () => {
    const cfg = {
      agent: { modelAliases: { Opus: "anthropic/claude-opus-4-5" } },
    } satisfies ClawdbotConfig;

    const next = applyModelAliasDefaults(cfg);

    expect(next.agent?.modelAliases).toMatchObject({
      opus: "anthropic/claude-opus-4-5",
    });
    expect(next.agent?.modelAliases).not.toHaveProperty("Opus");
  });

  it("does not override existing alias values", () => {
    const cfg = {
      agent: { modelAliases: { gpt: "openai/gpt-4.1" } },
    } satisfies ClawdbotConfig;

    const next = applyModelAliasDefaults(cfg);

    expect(next.agent?.modelAliases?.gpt).toBe("openai/gpt-4.1");
    expect(next.agent?.modelAliases).toMatchObject({
      "gpt-mini": "openai/gpt-5-mini",
      opus: "anthropic/claude-opus-4-5",
      sonnet: "anthropic/claude-sonnet-4-5",
      gemini: "google/gemini-3-pro-preview",
      "gemini-flash": "google/gemini-3-flash-preview",
    });
  });

  it("does not rename when casing differs and value differs", () => {
    const cfg = {
      agent: { modelAliases: { GPT: "openai/gpt-4.1-mini" } },
    } satisfies ClawdbotConfig;

    const next = applyModelAliasDefaults(cfg);

    expect(next.agent?.modelAliases).toMatchObject({
      GPT: "openai/gpt-4.1-mini",
    });
    expect(next.agent?.modelAliases).not.toHaveProperty("gpt");
  });

  it("respects explicit empty-string disables", () => {
    const cfg = {
      agent: { modelAliases: { gemini: "" } },
    } satisfies ClawdbotConfig;

    const next = applyModelAliasDefaults(cfg);

    expect(next.agent?.modelAliases?.gemini).toBe("");
    expect(next.agent?.modelAliases).toHaveProperty(
      "gemini-flash",
      "google/gemini-3-flash-preview",
    );
  });
});

describe("applyLoggingDefaults", () => {
  it("defaults redactSensitive to tools", () => {
    const result = applyLoggingDefaults({ logging: {} });
    expect(result.logging?.redactSensitive).toBe("tools");
  });

  it("preserves explicit redactSensitive", () => {
    const result = applyLoggingDefaults({
      logging: { redactSensitive: "off" },
    });
    expect(result.logging?.redactSensitive).toBe("off");
  });
});
