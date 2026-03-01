import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { patchAgentDefaultModel, patchAgentDefaults } from "./model-default.js";

const baseConfig: OpenClawConfig = {
  agents: {
    defaults: {
      workspace: "/home/user/workspace",
      model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-4o"] },
      models: { "anthropic/claude-opus-4-6": {} },
    },
  },
};

describe("patchAgentDefaults", () => {
  it("patches a leaf field without touching other defaults fields", () => {
    const result = patchAgentDefaults(baseConfig, { workspace: "/new/workspace" });
    expect(result.agents?.defaults?.workspace).toBe("/new/workspace");
    // other defaults fields preserved
    expect(result.agents?.defaults?.model).toEqual(baseConfig.agents?.defaults?.model);
    expect(result.agents?.defaults?.models).toEqual(baseConfig.agents?.defaults?.models);
  });

  it("preserves all other top-level cfg fields", () => {
    const cfg: OpenClawConfig = {
      ...baseConfig,
      gateway: { mode: "local", port: 18789 },
    };
    const result = patchAgentDefaults(cfg, { workspace: "/tmp" });
    expect(result.gateway).toEqual(cfg.gateway);
  });

  it("patches models field preserving other defaults", () => {
    const nextModels = { "openai/gpt-4o": {}, "anthropic/claude-opus-4-6": {} };
    const result = patchAgentDefaults(baseConfig, { models: nextModels });
    expect(result.agents?.defaults?.models).toEqual(nextModels);
    expect(result.agents?.defaults?.workspace).toBe(baseConfig.agents?.defaults?.workspace);
    expect(result.agents?.defaults?.model).toEqual(baseConfig.agents?.defaults?.model);
  });

  it("creates agents.defaults when cfg has none", () => {
    const cfg: OpenClawConfig = {};
    const result = patchAgentDefaults(cfg, { workspace: "/tmp" });
    expect(result.agents?.defaults?.workspace).toBe("/tmp");
  });

  it("patches multiple fields at once", () => {
    const result = patchAgentDefaults(baseConfig, {
      workspace: "/new",
      timeoutSeconds: 120,
    });
    expect(result.agents?.defaults?.workspace).toBe("/new");
    expect(result.agents?.defaults?.timeoutSeconds).toBe(120);
    expect(result.agents?.defaults?.model).toEqual(baseConfig.agents?.defaults?.model);
  });
});

describe("patchAgentDefaultModel", () => {
  it("preserves existing fallbacks when patching model primary", () => {
    const result = patchAgentDefaultModel(baseConfig, { primary: "openai/gpt-5" });
    expect(result.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5",
      fallbacks: ["openai/gpt-4o"],
    });
  });

  it("creates new model object when model was undefined", () => {
    const cfg: OpenClawConfig = { agents: { defaults: {} } };
    const result = patchAgentDefaultModel(cfg, { primary: "openai/gpt-4o" });
    expect(result.agents?.defaults?.model).toEqual({ primary: "openai/gpt-4o" });
  });

  it("creates new model object when model was a string", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
    };
    // When existing model is a string, patchAgentDefaultModel does not spread it
    // (strings have no enumerable own properties), so patch replaces the string.
    const result = patchAgentDefaultModel(cfg, { primary: "openai/gpt-4o" });
    expect(result.agents?.defaults?.model).toEqual({ primary: "openai/gpt-4o" });
  });

  it("preserves all other top-level cfg fields", () => {
    const cfg: OpenClawConfig = {
      ...baseConfig,
      gateway: { mode: "local", port: 18789 },
    };
    const result = patchAgentDefaultModel(cfg, { primary: "openai/gpt-4o" });
    expect(result.gateway).toEqual(cfg.gateway);
  });

  it("preserves other defaults fields when patching model", () => {
    const result = patchAgentDefaultModel(baseConfig, { primary: "openai/gpt-4o" });
    expect(result.agents?.defaults?.workspace).toBe(baseConfig.agents?.defaults?.workspace);
    expect(result.agents?.defaults?.models).toEqual(baseConfig.agents?.defaults?.models);
  });

  it("patches fallbacks field preserving primary", () => {
    const result = patchAgentDefaultModel(baseConfig, { fallbacks: ["openai/gpt-4o-mini"] });
    expect(result.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-4o-mini"],
    });
  });
});
