/** Model-selection config fixtures for fallback and off-catalog routes. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createFixtureRouteModels(): OpenClawConfig["models"] {
  return {
    providers: {
      "fixture-route": {
        api: "openai-responses",
        baseUrl: "https://fixture.invalid/v1",
        models: [],
      },
    },
  };
}

export function makeModelFallbackCfg(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-haiku-3-5"],
        },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

export function createModelFallbackConfig(primary: string, fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary, fallbacks },
      },
    },
  };
}
