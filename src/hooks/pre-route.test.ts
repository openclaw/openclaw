import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRoutedModelRef,
  resolveRouterConfig,
  routeMessage,
  type RouterConfig,
} from "./pre-route.js";

// ---------------------------------------------------------------------------
// resolveRouterConfig
// ---------------------------------------------------------------------------

describe("resolveRouterConfig", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns null when router is absent", () => {
    expect(resolveRouterConfig({})).toBeNull();
  });

  it("returns null when router.enabled is false", () => {
    expect(
      resolveRouterConfig({
        router: { enabled: false, tiers: { "1": "a/b" }, defaultTier: "1" },
      }),
    ).toBeNull();
  });

  it("returns null and warns when tiers is missing", () => {
    expect(resolveRouterConfig({ router: { enabled: true, defaultTier: "1" } })).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no tiers configured"));
  });

  it("returns null and warns when defaultTier is missing", () => {
    expect(
      resolveRouterConfig({
        router: { enabled: true, tiers: { "1": "a/b" } },
      }),
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("defaultTier missing"));
  });

  it("returns null and warns when defaultTier is not in tiers", () => {
    expect(
      resolveRouterConfig({
        router: { enabled: true, tiers: { "1": "a/b" }, defaultTier: "99" },
      }),
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("defaultTier missing"));
  });

  it("returns a valid RouterConfig when properly configured", () => {
    const result = resolveRouterConfig({
      router: {
        enabled: true,
        baseUrl: "http://jetson:11434",
        model: "qwen3:4b",
        timeoutMs: 5000,
        tiers: {
          "1": "minimax/MiniMax-Text-01",
          "2": "anthropic/claude-haiku-4-5-20251001",
          "3": "anthropic/claude-opus-4-6",
        },
        defaultTier: "2",
      },
    });

    expect(result).toEqual({
      enabled: true,
      baseUrl: "http://jetson:11434",
      model: "qwen3:4b",
      timeoutMs: 5000,
      tiers: {
        "1": "minimax/MiniMax-Text-01",
        "2": "anthropic/claude-haiku-4-5-20251001",
        "3": "anthropic/claude-opus-4-6",
      },
      defaultTier: "2",
    });
  });
});

// ---------------------------------------------------------------------------
// parseRoutedModelRef
// ---------------------------------------------------------------------------

describe("parseRoutedModelRef", () => {
  it("splits provider/model on first slash", () => {
    expect(parseRoutedModelRef("anthropic/claude-opus-4-6")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("handles model refs with multiple slashes", () => {
    expect(parseRoutedModelRef("openai/gpt-4o/turbo")).toEqual({
      provider: "openai",
      model: "gpt-4o/turbo",
    });
  });

  it("defaults to anthropic when no slash is present", () => {
    expect(parseRoutedModelRef("claude-haiku-4-5-20251001")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });
});

// ---------------------------------------------------------------------------
// routeMessage
// ---------------------------------------------------------------------------

describe("routeMessage", () => {
  const baseCfg: RouterConfig = {
    enabled: true,
    tiers: {
      "1": "minimax/MiniMax-Text-01",
      "2": "anthropic/claude-haiku-4-5-20251001",
      "3": "anthropic/claude-opus-4-6",
    },
    defaultTier: "2",
    timeoutMs: 5000,
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function mockOllamaResponse(responseText: string) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: responseText }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("routes to tier 1 for casual messages", async () => {
    mockOllamaResponse("1");
    const result = await routeMessage("hey", baseCfg);

    expect(result.tier).toBe("1");
    expect(result.modelRef).toBe("minimax/MiniMax-Text-01");
    expect(result.fallback).toBe(false);
  });

  it("routes to tier 2 for code messages", async () => {
    mockOllamaResponse("2");
    const result = await routeMessage("fix this TypeError", baseCfg);

    expect(result.tier).toBe("2");
    expect(result.modelRef).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(result.fallback).toBe(false);
  });

  it("routes to tier 3 for complex messages", async () => {
    mockOllamaResponse("3");
    const result = await routeMessage("design a system", baseCfg);

    expect(result.tier).toBe("3");
    expect(result.modelRef).toBe("anthropic/claude-opus-4-6");
    expect(result.fallback).toBe(false);
  });

  it("strips non-alphanumeric characters from response", async () => {
    mockOllamaResponse("  2. ");
    const result = await routeMessage("debug this", baseCfg);

    expect(result.tier).toBe("2");
    expect(result.fallback).toBe(false);
  });

  it("falls back to defaultTier on unrecognized output", async () => {
    mockOllamaResponse("banana");
    const result = await routeMessage("hello", baseCfg);

    expect(result.tier).toBe("2");
    expect(result.modelRef).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(result.fallback).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unrecognized tier"));
  });

  it("falls back on fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await routeMessage("hello", baseCfg);

    expect(result.tier).toBe("2");
    expect(result.fallback).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Classification failed"));
  });

  it("falls back on non-ok HTTP status", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const result = await routeMessage("hello", baseCfg);

    expect(result.tier).toBe("2");
    expect(result.fallback).toBe(true);
  });

  it("reports latencyMs", async () => {
    mockOllamaResponse("1");
    const result = await routeMessage("hey", baseCfg);

    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends correct payload to Ollama", async () => {
    mockOllamaResponse("1");
    await routeMessage("test message", baseCfg);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.prompt).toBe("test message");
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.0);
  });

  it("uses custom baseUrl from config", async () => {
    mockOllamaResponse("1");
    await routeMessage("hey", {
      ...baseCfg,
      baseUrl: "http://jetson:11434",
    });

    expect(fetchSpy).toHaveBeenCalledWith("http://jetson:11434/api/generate", expect.anything());
  });
});
