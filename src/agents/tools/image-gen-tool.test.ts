import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    tools: {
      imageGen: {
        provider: "sglang-diffusion",
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "test-key", // pragma: allowlist secret
        model: "FLUX.1-dev",
      },
    },
  })),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock("../../media/store.js", () => ({
  ensureMediaDir: vi.fn(async () => "/tmp/openclaw-test-media"),
}));

vi.mock("../model-auth.js", () => ({
  resolveEnvApiKey: vi.fn(() => null),
  resolveApiKeyForProvider: vi.fn(async () => null),
}));

vi.mock("node:fs/promises", () => ({
  default: { writeFile: vi.fn() },
  writeFile: vi.fn(),
}));

const { createImageGenTool } = await import("./image-gen-tool.js");

// Small 1x1 white PNG as base64
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("createImageGenTool", () => {
  it("returns null when no provider is configured", () => {
    // Pass an empty config explicitly — no tools.imageGen, env fallback returns null.
    const tool = createImageGenTool({
      config: {} as ReturnType<typeof import("../../config/config.js").loadConfig>,
    });
    expect(tool).toBeNull();
  });

  it("creates tool when tools.imageGen is configured", () => {
    // Default mock returns config with tools.imageGen.
    const tool = createImageGenTool();
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("image_gen");
    expect(tool!.label).toBe("Image Generation");
    expect(tool!.description).toContain("SGLang-Diffusion");
  });

  it("creates tool from legacy models.providers location (backward compat)", () => {
    const tool = createImageGenTool({
      config: {
        models: {
          providers: {
            "sglang-diffusion": {
              baseUrl: "http://127.0.0.1:30000/v1",
              apiKey: "legacy-key", // pragma: allowlist secret
              api: "openai-completions",
              models: [
                {
                  id: "FLUX.1-dev",
                  name: "FLUX.1-dev",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1,
                  maxTokens: 1,
                },
              ],
            },
          },
        },
      } as ReturnType<typeof import("../../config/config.js").loadConfig>,
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("image_gen");
  });

  it("creates tool when SGLANG_DIFFUSION_API_KEY env var is set", async () => {
    const { resolveEnvApiKey } = await import("../model-auth.js");
    vi.mocked(resolveEnvApiKey).mockReturnValueOnce({
      apiKey: "env-key", // pragma: allowlist secret
      source: "env: SGLANG_DIFFUSION_API_KEY",
    });

    // Empty config but env var resolves — should still create the tool.
    const tool = createImageGenTool({
      config: {} as ReturnType<typeof import("../../config/config.js").loadConfig>,
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("image_gen");
  });
});

describe("image_gen tool execution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls /v1/images/generations and returns image result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ b64_json: TINY_PNG_B64 }],
      }),
    }) as unknown as typeof fetch;

    const tool = createImageGenTool();
    expect(tool).not.toBeNull();

    const result = await tool!.execute(
      "call-1",
      { prompt: "a red cat" },
      new AbortController().signal,
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:30000/v1/images/generations");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.prompt).toBe("a red cat");
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("1024x1024");

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    // Should include MEDIA: path in text content
    const textContent = result.content.find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    expect((textContent as { text: string }).text).toContain("MEDIA:");
  });

  it("passes optional parameters to the API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ b64_json: TINY_PNG_B64 }],
      }),
    }) as unknown as typeof fetch;

    const tool = createImageGenTool();
    await tool!.execute(
      "call-2",
      {
        prompt: "sunset",
        size: "1024x768",
        negative_prompt: "blurry",
        num_inference_steps: 30,
        guidance_scale: 7.5,
        seed: 42,
      },
      new AbortController().signal,
    );

    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.size).toBe("1024x768");
    expect(body.negative_prompt).toBe("blurry");
    expect(body.num_inference_steps).toBe(30);
    expect(body.guidance_scale).toBe(7.5);
    expect(body.seed).toBe(42);
  });

  it("handles API errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as typeof fetch;

    const tool = createImageGenTool();
    const result = await tool!.execute("call-3", { prompt: "test" }, new AbortController().signal);

    const textContent = result.content.find((c) => c.type === "text") as { text: string };
    expect(textContent.text).toContain("Image generation failed");
    expect(textContent.text).toContain("500");
  });

  it("handles empty response data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    const tool = createImageGenTool();
    const result = await tool!.execute("call-4", { prompt: "test" }, new AbortController().signal);

    const textContent = result.content.find((c) => c.type === "text") as { text: string };
    expect(textContent.text).toContain("No image data returned");
  });

  it("handles network errors gracefully", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:30000"),
      ) as unknown as typeof fetch;

    const tool = createImageGenTool();
    const result = await tool!.execute("call-5", { prompt: "test" }, new AbortController().signal);

    const textContent = result.content.find((c) => c.type === "text") as { text: string };
    expect(textContent.text).toContain("Image generation failed");
    expect(textContent.text).toContain("ECONNREFUSED");
  });

  it("includes Authorization header when apiKey is set", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }] }),
    }) as unknown as typeof fetch;

    const tool = createImageGenTool();
    await tool!.execute("call-6", { prompt: "test" }, new AbortController().signal);

    const [, options] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });
});
