import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObject } from "./config.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

const { __testing } = await import("../agents/tools/web-search.js");
const { resolveSearchProvider, resolveQueritApiKey, resolveQueritConfig } = __testing;

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key",
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
          apiKey: "test-key",
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
    delete process.env.QUERIT_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to brave when no keys available", () => {
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key";
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows priority order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.XAI_API_KEY = "test-xai-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over perplexity and grok when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });

  it("auto-detects querit when only QUERIT_API_KEY is set", () => {
    process.env.QUERIT_API_KEY = "test-querit-key";
    expect(resolveSearchProvider({})).toBe("querit");
  });

  it("querit loses to brave when both keys are set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.QUERIT_API_KEY = "test-querit-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("querit loses to gemini when both keys are set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.QUERIT_API_KEY = "test-querit-key";
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("explicit querit provider always wins regardless of other keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(
      resolveSearchProvider({ provider: "querit" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("querit");
  });
});

describe("querit provider config", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("accepts querit provider with apiKey config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "querit",
        providerConfig: {
          apiKey: "test-querit-key",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts querit provider with no extra config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "querit",
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("resolveQueritConfig returns empty object when no search config", () => {
    expect(resolveQueritConfig(undefined)).toEqual({});
    expect(resolveQueritConfig({} as never)).toEqual({});
  });

  it("resolveQueritConfig extracts apiKey from search config", () => {
    const config = { querit: { apiKey: "from-config" } } as never;
    expect(resolveQueritConfig(config)).toEqual({ apiKey: "from-config" });
  });

  it("resolveQueritApiKey reads apiKey from config", () => {
    expect(resolveQueritApiKey({ apiKey: "config-key" })).toBe("config-key");
  });

  it("resolveQueritApiKey falls back to QUERIT_API_KEY env var", () => {
    process.env.QUERIT_API_KEY = "env-key";
    expect(resolveQueritApiKey({})).toBe("env-key");
  });

  it("resolveQueritApiKey prefers config apiKey over env var", () => {
    process.env.QUERIT_API_KEY = "env-key";
    expect(resolveQueritApiKey({ apiKey: "config-key" })).toBe("config-key");
  });

  it("resolveQueritApiKey returns undefined when no key available", () => {
    delete process.env.QUERIT_API_KEY;
    expect(resolveQueritApiKey({})).toBeUndefined();
  });
});
