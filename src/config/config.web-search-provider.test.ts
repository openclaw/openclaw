import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObject } from "./config.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

const { __testing } = await import("../agents/tools/web-search.js");
const { resolveSearchProvider } = __testing;

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

  it("accepts ark provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "ark",
        providerConfig: {
          apiKey: "test-ark-key",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          model: "doubao-seed-1-6-250615",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts ark provider with no extra config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "ark",
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
    delete process.env.ARK_API_KEY;
    delete process.env.VOLCENGINE_API_KEY;
    delete process.env.VOLCANO_ENGINE_API_KEY;
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

  it("auto-detects ark when only ARK_API_KEY is set", () => {
    process.env.ARK_API_KEY = "test-ark-key";
    expect(resolveSearchProvider({})).toBe("ark");
  });

  it("auto-detects ark when only VOLCENGINE_API_KEY is set", () => {
    process.env.VOLCENGINE_API_KEY = "test-volc-key";
    expect(resolveSearchProvider({})).toBe("ark");
  });

  it("auto-detects ark when only VOLCANO_ENGINE_API_KEY is set", () => {
    process.env.VOLCANO_ENGINE_API_KEY = "test-volcano-key";
    expect(resolveSearchProvider({})).toBe("ark");
  });

  it("explicit ark provider always wins", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    expect(
      resolveSearchProvider({ provider: "ark" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("ark");
  });

  it("follows priority order — brave wins over ark", () => {
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.ARK_API_KEY = "test-ark-key";
    expect(resolveSearchProvider({})).toBe("brave");
  });
});
