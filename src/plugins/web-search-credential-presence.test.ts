import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => [
    {
      id: "brave",
      pluginId: "brave",
      envVars: ["BRAVE_API_KEY"],
      getCredentialValue: (searchConfig: Record<string, unknown> | undefined) =>
        searchConfig?.apiKey,
    },
    {
      id: "gemini",
      pluginId: "gemini",
      envVars: ["GEMINI_API_KEY"],
      getCredentialValue: (searchConfig: Record<string, unknown> | undefined) =>
        (searchConfig?.gemini as { apiKey?: unknown } | undefined)?.apiKey,
    },
    {
      id: "grok",
      pluginId: "grok",
      envVars: ["XAI_API_KEY"],
      getCredentialValue: (searchConfig: Record<string, unknown> | undefined) =>
        (searchConfig?.grok as { apiKey?: unknown } | undefined)?.apiKey,
    },
    {
      id: "kimi",
      pluginId: "kimi",
      envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
      getCredentialValue: (searchConfig: Record<string, unknown> | undefined) =>
        (searchConfig?.kimi as { apiKey?: unknown } | undefined)?.apiKey,
    },
    {
      id: "perplexity",
      pluginId: "perplexity",
      envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
      getCredentialValue: (searchConfig: Record<string, unknown> | undefined) =>
        (searchConfig?.perplexity as { apiKey?: unknown } | undefined)?.apiKey,
    },
  ]),
}));

vi.mock("./web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

let hasConfiguredWebSearchCredential: typeof import("./web-search-credential-presence.js").hasConfiguredWebSearchCredential;

beforeAll(async () => {
  ({ hasConfiguredWebSearchCredential } = await import("./web-search-credential-presence.js"));
});

beforeEach(() => {
  resolvePluginWebSearchProvidersMock.mockClear();
});

describe("hasConfiguredWebSearchCredential", () => {
  it("keeps empty config and env on the manifest-only path", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
        bundledAllowlistCompat: true,
      }),
    ).toBe(false);
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("loads provider runtime only when a credential candidate exists", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "brave-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
        bundledAllowlistCompat: true,
      }),
    ).toBe(true);
    expect(resolvePluginWebSearchProvidersMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["gemini", { gemini: { apiKey: "gemini-key" } }],
    ["grok", { grok: { apiKey: "grok-key" } }],
    ["kimi", { kimi: { apiKey: "kimi-key" } }],
    ["perplexity", { perplexity: { apiKey: "pplx-key" } }],
  ])("detects %s web search credentials from config", (_provider, searchConfig) => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: searchConfig } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
        bundledAllowlistCompat: true,
      }),
    ).toBe(true);
  });

  it.each([
    ["gemini", { provider: "gemini" }, { GEMINI_API_KEY: "gemini-env-key" }],
    ["grok", { provider: "grok" }, { XAI_API_KEY: "xai-env-key" }],
    ["kimi", { provider: "kimi" }, { MOONSHOT_API_KEY: "moonshot-env-key" }],
    ["perplexity", { provider: "perplexity" }, { OPENROUTER_API_KEY: "openrouter-env-key" }],
  ])("detects %s web search credentials from env", (_provider, searchConfig, env) => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: searchConfig } },
        } as OpenClawConfig,
        env: env as NodeJS.ProcessEnv,
        origin: "bundled",
        bundledAllowlistCompat: true,
      }),
    ).toBe(true);
  });
});
