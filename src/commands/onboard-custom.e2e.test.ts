import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  applyCustomApiConfig,
  parseNonInteractiveCustomApiFlags,
  promptCustomApiConfig,
} from "./onboard-custom.js";

// Mock dependencies
vi.mock("./model-picker.js", () => ({
  applyPrimaryModel: vi.fn((cfg) => cfg),
}));

describe("promptCustomApiConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("handles openai flow and saves alias", async () => {
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434/v1") // Base URL
        .mockResolvedValueOnce("") // API Key
        .mockResolvedValueOnce("llama3") // Model ID
        .mockResolvedValueOnce("custom") // Endpoint ID
        .mockResolvedValueOnce("local"), // Alias
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn().mockResolvedValueOnce("openai"), // Compatibility
      confirm: vi.fn(),
      note: vi.fn(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      }),
    );

    const result = await promptCustomApiConfig({
      prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
      runtime: { ...defaultRuntime, log: vi.fn() },
      config: {},
    });

    expect(prompter.text).toHaveBeenCalledTimes(5);
    expect(prompter.select).toHaveBeenCalledTimes(1);
    expect(result.config.models?.providers?.custom?.api).toBe("openai-completions");
    expect(result.config.agents?.defaults?.models?.["custom/llama3"]?.alias).toBe("local");
  });

  it("retries when verification fails", async () => {
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434/v1") // Base URL
        .mockResolvedValueOnce("") // API Key
        .mockResolvedValueOnce("bad-model") // Model ID
        .mockResolvedValueOnce("good-model") // Model ID retry
        .mockResolvedValueOnce("custom") // Endpoint ID
        .mockResolvedValueOnce(""), // Alias
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi
        .fn()
        .mockResolvedValueOnce("openai") // Compatibility
        .mockResolvedValueOnce("model"), // Retry choice
      confirm: vi.fn(),
      note: vi.fn(),
    };

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }),
    );

    await promptCustomApiConfig({
      prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
      runtime: { ...defaultRuntime, log: vi.fn() },
      config: {},
    });

    expect(prompter.text).toHaveBeenCalledTimes(6);
    expect(prompter.select).toHaveBeenCalledTimes(2);
  });

  it("detects openai compatibility when unknown", async () => {
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("https://example.com/v1") // Base URL
        .mockResolvedValueOnce("test-key") // API Key
        .mockResolvedValueOnce("detected-model") // Model ID
        .mockResolvedValueOnce("custom") // Endpoint ID
        .mockResolvedValueOnce("alias"), // Alias
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn().mockResolvedValueOnce("unknown"),
      confirm: vi.fn(),
      note: vi.fn(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      }),
    );

    const result = await promptCustomApiConfig({
      prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
      runtime: { ...defaultRuntime, log: vi.fn() },
      config: {},
    });

    expect(prompter.text).toHaveBeenCalledTimes(5);
    expect(prompter.select).toHaveBeenCalledTimes(1);
    expect(result.config.models?.providers?.custom?.api).toBe("openai-completions");
  });

  it("re-prompts base url when unknown detection fails", async () => {
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("https://bad.example.com/v1") // Base URL #1
        .mockResolvedValueOnce("bad-key") // API Key #1
        .mockResolvedValueOnce("bad-model") // Model ID #1
        .mockResolvedValueOnce("https://ok.example.com/v1") // Base URL #2
        .mockResolvedValueOnce("ok-key") // API Key #2
        .mockResolvedValueOnce("custom") // Endpoint ID
        .mockResolvedValueOnce(""), // Alias
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn().mockResolvedValueOnce("unknown").mockResolvedValueOnce("baseUrl"),
      confirm: vi.fn(),
      note: vi.fn(),
    };

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }),
    );

    await promptCustomApiConfig({
      prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
      runtime: { ...defaultRuntime, log: vi.fn() },
      config: {},
    });

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("did not respond"),
      "Endpoint detection",
    );
  });

  it("renames provider id when baseUrl differs", async () => {
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434/v1") // Base URL
        .mockResolvedValueOnce("") // API Key
        .mockResolvedValueOnce("llama3") // Model ID
        .mockResolvedValueOnce("custom") // Endpoint ID
        .mockResolvedValueOnce(""), // Alias
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn().mockResolvedValueOnce("openai"),
      confirm: vi.fn(),
      note: vi.fn(),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      }),
    );

    const result = await promptCustomApiConfig({
      prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
      runtime: { ...defaultRuntime, log: vi.fn() },
      config: {
        models: {
          providers: {
            custom: {
              baseUrl: "http://old.example.com/v1",
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "Old",
                  contextWindow: 1,
                  maxTokens: 1,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.providerId).toBe("custom-2");
    expect(result.config.models?.providers?.custom).toBeDefined();
    expect(result.config.models?.providers?.["custom-2"]).toBeDefined();
  });

  it("aborts verification after timeout", async () => {
    vi.useFakeTimers();
    const prompter = {
      text: vi
        .fn()
        .mockResolvedValueOnce("http://localhost:11434/v1") // Base URL
        .mockResolvedValueOnce("") // API Key
        .mockResolvedValueOnce("slow-model") // Model ID
        .mockResolvedValueOnce("fast-model") // Model ID retry
        .mockResolvedValueOnce("custom") // Endpoint ID
        .mockResolvedValueOnce(""), // Alias
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
      select: vi.fn().mockResolvedValueOnce("openai").mockResolvedValueOnce("model"),
      confirm: vi.fn(),
      note: vi.fn(),
    };

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const promise = promptCustomApiConfig({
      prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
      runtime: { ...defaultRuntime, log: vi.fn() },
      config: {},
    });

    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    expect(prompter.text).toHaveBeenCalledTimes(6);
  });
});

describe("applyCustomApiConfig", () => {
  it("rejects invalid compatibility values at runtime", () => {
    expect(() =>
      applyCustomApiConfig({
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "invalid" as unknown as "openai",
      }),
    ).toThrow('Custom provider compatibility must be "openai" or "anthropic".');
  });

  it("rejects explicit provider ids that normalize to empty", () => {
    expect(() =>
      applyCustomApiConfig({
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "openai",
        providerId: "!!!",
      }),
    ).toThrow("Custom provider ID must include letters, numbers, or hyphens.");
  });
});

describe("parseNonInteractiveCustomApiFlags", () => {
  it("parses required flags and defaults compatibility to openai", () => {
    const result = parseNonInteractiveCustomApiFlags({
      baseUrl: " https://llm.example.com/v1 ",
      modelId: " foo-large ",
      apiKey: " custom-test-key ",
      providerId: " my-custom ",
    });

    expect(result).toEqual({
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      apiKey: "custom-test-key",
      providerId: "my-custom",
    });
  });

  it("rejects missing required flags", () => {
    expect(() =>
      parseNonInteractiveCustomApiFlags({
        baseUrl: "https://llm.example.com/v1",
      }),
    ).toThrow('Auth choice "custom-api-key" requires a base URL and model ID.');
  });

  it("rejects invalid compatibility values", () => {
    expect(() =>
      parseNonInteractiveCustomApiFlags({
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "xmlrpc",
      }),
    ).toThrow('Invalid --custom-compatibility (use "openai" or "anthropic").');
  });

  it("rejects invalid explicit provider ids", () => {
    expect(() =>
      parseNonInteractiveCustomApiFlags({
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        providerId: "!!!",
      }),
    ).toThrow("Custom provider ID must include letters, numbers, or hyphens.");
  });
});
