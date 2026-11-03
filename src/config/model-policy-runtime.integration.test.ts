import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAllowedModelSet } from "../agents/model-selection-shared.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectRaw } from "./validation-core.js";

afterEach(() => vi.unstubAllEnvs());

describe("model policy across provider defaults", () => {
  it.each([
    { name: "absent model settings", models: undefined, allowed: true },
    {
      name: "authored legacy restriction",
      models: { "anthropic/claude-sonnet-4-6": {} },
      allowed: false,
    },
    { name: "unresolved legacy restriction", models: { "private-model": {} }, allowed: false },
  ])("preserves $name", ({ models, allowed }) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-test-key");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    const source: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: "anthropic/claude-sonnet-4-6", ...(models ? { models } : {}) },
      },
    };
    const runtime = materializeRuntimeConfig(source, { manifestRegistry: { plugins: [] } });
    expect(
      runtime.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.params?.cacheRetention,
    ).toBe("short");
    const policy = buildAllowedModelSet({
      cfg: runtime,
      catalog: [{ provider: "openai", id: "test-model", name: "Test model", contextWindow: 8192 }],
      defaultProvider: "anthropic",
    });
    expect(policy.allows({ provider: "openai", model: "test-model" })).toBe(allowed);
    expect(source.agents?.defaults?.models).toEqual(models);
    expect(validateConfigObjectRaw(runtime).ok).toBe(true);
  });
});
