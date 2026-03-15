import { describe, expect, it } from "vitest";
import {
  formatConfigPath,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

describe("doctor config analysis helpers", () => {
  it("formats config paths predictably", () => {
    expect(formatConfigPath([])).toBe("<root>");
    expect(formatConfigPath(["channels", "slack", "accounts", 0, "token"])).toBe(
      "channels.slack.accounts[0].token",
    );
  });

  it("resolves nested config targets without throwing", () => {
    const target = resolveConfigPathTarget(
      { channels: { slack: { accounts: [{ token: "x" }] } } },
      ["channels", "slack", "accounts", 0],
    );
    expect(target).toEqual({ token: "x" });
    expect(resolveConfigPathTarget({ channels: null }, ["channels", "slack"])).toBeNull();
  });

  it("strips unknown config keys while keeping known values", () => {
    const result = stripUnknownConfigKeys({
      hooks: {},
      unexpected: true,
    } as never);
    expect(result.removed).toContain("unexpected");
    expect((result.config as Record<string, unknown>).unexpected).toBeUndefined();
    expect((result.config as Record<string, unknown>).hooks).toEqual({});
  });

  it("preserves params on models.providers.*.models[] entries", () => {
    const config = {
      models: {
        providers: {
          customProvider: {
            baseUrl: "https://api.example.com",
            models: [
              {
                id: "my-model",
                name: "My Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
                maxTokens: 2048,
                params: { temperature: 0.8 },
              },
            ],
          },
        },
      },
    } as never;
    const result = stripUnknownConfigKeys(config);
    expect(result.removed).not.toContain("models.providers.customProvider.models[0].params");
    const models = (
      result.config as { models?: { providers?: Record<string, { models?: unknown[] }> } }
    ).models?.providers?.customProvider?.models;
    expect(models?.[0]).toMatchObject({ params: { temperature: 0.8 } });
  });
});
