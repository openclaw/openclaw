import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatConfigPath,
  resolveConfigPathTarget,
  stripUnknownConfigKeys,
} from "./doctor-config-analysis.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note: noteMock,
}));

describe("doctor config analysis helpers", () => {
  beforeEach(() => {
    noteMock.mockReset();
  });

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

  it("preserves active auth profile secrets when the provider has configured API keys", () => {
    const result = stripUnknownConfigKeys({
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            apiKey: "legacy-openai-key",
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "${OPENAI_API_KEY}",
            models: [],
          },
        },
      },
    } as never);

    expect(result.removed).toEqual([]);
    expect((result.config as Record<string, unknown>).auth).toMatchObject({
      profiles: {
        "openai:default": {
          provider: "openai",
          mode: "api_key",
          apiKey: "legacy-openai-key",
        },
      },
    });
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("auth.profiles.openai:default.apiKey"),
      "Doctor warnings",
    );
  });

  it("preserves active auth profile secrets when the provider is referenced in model fallbacks", () => {
    const result = stripUnknownConfigKeys({
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            apiKey: "legacy-openai-key",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as never);

    expect(result.removed).toEqual([]);
    expect((result.config as Record<string, unknown>).auth).toMatchObject({
      profiles: {
        "openai:default": {
          provider: "openai",
          mode: "api_key",
          apiKey: "legacy-openai-key",
        },
      },
    });
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("auth.profiles.openai:default.apiKey"),
      "Doctor warnings",
    );
  });
});
