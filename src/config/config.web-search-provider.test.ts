import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObject } from "./config.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../plugins/web-search-providers.js", () => {
  const getScoped = (key: string) => (search?: Record<string, unknown>) =>
    (search?.[key] as { apiKey?: unknown } | undefined)?.apiKey;
  return {
    resolvePluginWebSearchProviders: () => [
      {
        id: "brave",
        envVars: ["BRAVE_API_KEY"],
        getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
      },
      {
        id: "gemini",
        envVars: ["GEMINI_API_KEY"],
        getCredentialValue: getScoped("gemini"),
      },
      {
        id: "grok",
        envVars: ["XAI_API_KEY"],
        getCredentialValue: getScoped("grok"),
      },
      {
        id: "kimi",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        getCredentialValue: getScoped("kimi"),
      },
      {
        id: "perplexity",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
        getCredentialValue: getScoped("perplexity"),
      },
    ],
  };
});

const { __testing } = await import("../agents/tools/web-search.js");
const { resolveSearchProvider } = __testing;

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key", // pragma: allowlist secret
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "gemini",
        providerConfig: {
          apiKey: "test-key", // pragma: allowlist secret
          model: "gemini-2.5-flash",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts brave llm-context mode config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "brave",
        providerConfig: {
          mode: "llm-context",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("rejects invalid brave mode config values", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "brave",
        providerConfig: {
          mode: "invalid-mode",
        },
      }),
    );

    expect(res.ok).toBe(false);
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to brave when no keys available", () => {
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects perplexity when only OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows alphabetical order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over grok, kimi, and perplexity when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("grok wins over kimi and perplexity when brave and gemini unavailable", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });
});
