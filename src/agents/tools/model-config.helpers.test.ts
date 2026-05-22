import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { hasProviderAuthForTool } from "./model-config.helpers.js";

describe("hasProviderAuthForTool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts config-backed custom provider auth", () => {
    const cfg = {
      models: {
        providers: {
          hatchery: {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(hasProviderAuthForTool({ provider: "hatchery", cfg })).toBe(true);
  });

  it("keeps auth-store profiles as valid tool auth", () => {
    expect(
      hasProviderAuthForTool({
        provider: "hatchery",
        authStore: {
          version: 1,
          profiles: {
            "hatchery:default": {
              provider: "hatchery",
              type: "api_key",
              key: "sk-profile", // pragma: allowlist secret
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects aws-sdk auth because tool execution requires an API key string", () => {
    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            auth: "aws-sdk",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(hasProviderAuthForTool({ provider: "amazon-bedrock", cfg })).toBe(false);
  });

  it("rejects implicit amazon-bedrock aws-sdk auth for tool preflight", () => {
    expect(hasProviderAuthForTool({ provider: "amazon-bedrock", cfg: {} })).toBe(false);
  });

  it("rejects providers without config, env, or profile auth", () => {
    expect(hasProviderAuthForTool({ provider: "unconfigured-provider" })).toBe(false);
  });
});
