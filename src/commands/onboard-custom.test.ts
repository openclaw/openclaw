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

function createTestPrompter(params: { text: string[]; select?: string[] }): {
  text: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  note: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
} {
  const text = vi.fn();
  for (const answer of params.text) {
    text.mockResolvedValueOnce(answer);
  }
  const select = vi.fn();
  for (const answer of params.select ?? []) {
    select.mockResolvedValueOnce(answer);
  }
  return {
    text,
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
    select,
    confirm: vi.fn(),
    note: vi.fn(),
  };
}

function stubFetchSequence(
  responses: Array<{ ok: boolean; status?: number }>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: response.ok,
      status: response.status,
      json: async () => ({}),
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runPromptCustomApi(
  prompter: ReturnType<typeof createTestPrompter>,
  config: object = {},
) {
  return promptCustomApiConfig({
    prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
    runtime: { ...defaultRuntime, log: vi.fn() },
    config,
  });
}

function expectOpenAiCompatResult(params: {
  prompter: ReturnType<typeof createTestPrompter>;
  textCalls: number;
  selectCalls: number;
  result: Awaited<ReturnType<typeof runPromptCustomApi>>;
}) {
  expect(params.prompter.text).toHaveBeenCalledTimes(params.textCalls);
  expect(params.prompter.select).toHaveBeenCalledTimes(params.selectCalls);
  expect(params.result.config.models?.providers?.custom?.api).toBe("openai-completions");
}

describe("promptCustomApiConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("handles openai flow and saves alias", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "llama3", "custom", "local"],
      select: ["plaintext", "openai"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, textCalls: 5, selectCalls: 2, result });
    expect(result.config.agents?.defaults?.models?.["custom/llama3"]?.alias).toBe("local");
  });

  it("retries when verification fails", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "bad-model", "good-model", "custom", ""],
      select: ["plaintext", "openai", "model"],
    });
    stubFetchSequence([{ ok: false, status: 400 }, { ok: true }]);
    await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledTimes(6);
    expect(prompter.select).toHaveBeenCalledTimes(3);
  });

  it("detects openai compatibility when unknown", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "unknown"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, textCalls: 5, selectCalls: 2, result });
  });

  it("uses expanded max_tokens for openai verification probes", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "openai"],
    });
    const fetchMock = stubFetchSequence([{ ok: true }]);

    await runPromptCustomApi(prompter);

    const firstCall = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(firstCall?.body).toBeDefined();
    expect(JSON.parse(firstCall?.body ?? "{}")).toMatchObject({ max_tokens: 1024 });
  });

  it("uses expanded max_tokens for anthropic verification probes", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "unknown"],
    });
    const fetchMock = stubFetchSequence([{ ok: false, status: 404 }, { ok: true }]);

    await runPromptCustomApi(prompter);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1]?.[1] as { body?: string } | undefined;
    expect(secondCall?.body).toBeDefined();
    expect(JSON.parse(secondCall?.body ?? "{}")).toMatchObject({ max_tokens: 1024 });
  });

  it("re-prompts base url when unknown detection fails", async () => {
    const prompter = createTestPrompter({
      text: [
        "https://bad.example.com/v1",
        "bad-key",
        "bad-model",
        "https://ok.example.com/v1",
        "ok-key",
        "custom",
        "",
      ],
      select: ["plaintext", "unknown", "baseUrl", "plaintext"],
    });
    stubFetchSequence([{ ok: false, status: 404 }, { ok: false, status: 404 }, { ok: true }]);
    await runPromptCustomApi(prompter);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("did not respond"),
      "Endpoint detection",
    );
  });

  it("renames provider id when baseUrl differs", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "llama3", "custom", ""],
      select: ["plaintext", "openai"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter, {
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
    });

    expect(result.providerId).toBe("custom-2");
    expect(result.config.models?.providers?.custom).toBeDefined();
    expect(result.config.models?.providers?.["custom-2"]).toBeDefined();
  });

  it("aborts verification after timeout", async () => {
    vi.useFakeTimers();
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "slow-model", "fast-model", "custom", ""],
      select: ["plaintext", "openai", "model"],
    });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPromptCustomApi(prompter);

    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    expect(prompter.text).toHaveBeenCalledTimes(6);
  });

  it("stores env SecretRef for custom provider when selected", async () => {
    vi.stubEnv("CUSTOM_PROVIDER_API_KEY", "test-env-key");
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "CUSTOM_PROVIDER_API_KEY", "detected-model", "custom", ""],
      select: ["ref", "env", "openai"],
    });
    const fetchMock = stubFetchSequence([{ ok: true }]);

    const result = await runPromptCustomApi(prompter);

    expect(result.config.models?.providers?.custom?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_PROVIDER_API_KEY",
    });
    const firstCall = fetchMock.mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(firstCall?.headers?.Authorization).toBe("Bearer test-env-key");
  });

  it("re-prompts source after provider ref preflight fails and succeeds with env ref", async () => {
    vi.stubEnv("CUSTOM_PROVIDER_API_KEY", "test-env-key");
    const prompter = createTestPrompter({
      text: [
        "https://example.com/v1",
        "/providers/custom/apiKey",
        "CUSTOM_PROVIDER_API_KEY",
        "detected-model",
        "custom",
        "",
      ],
      select: ["ref", "provider", "filemain", "env", "openai"],
    });
    stubFetchSequence([{ ok: true }]);

    const result = await runPromptCustomApi(prompter, {
      secrets: {
        providers: {
          filemain: {
            source: "file",
            path: "/tmp/openclaw-missing-provider.json",
            mode: "json",
          },
        },
      },
    });

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
    expect(result.config.models?.providers?.custom?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_PROVIDER_API_KEY",
    });
  });
});

describe("applyCustomApiConfig", () => {
  it.each([
    {
      name: "invalid compatibility values at runtime",
      params: {
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "invalid" as unknown as "openai",
      },
      expectedMessage: 'Custom provider compatibility must be "openai" or "anthropic".',
    },
    {
      name: "explicit provider ids that normalize to empty",
      params: {
        config: {},
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "openai" as const,
        providerId: "!!!",
      },
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
    },
  ])("rejects $name", ({ params, expectedMessage }) => {
    expect(() => applyCustomApiConfig(params)).toThrow(expectedMessage);
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

  it.each([
    {
      name: "missing required flags",
      flags: { baseUrl: "https://llm.example.com/v1" },
      expectedMessage: 'Auth choice "custom-api-key" requires a base URL and model ID.',
    },
    {
      name: "invalid compatibility values",
      flags: {
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        compatibility: "xmlrpc",
      },
      expectedMessage: 'Invalid --custom-compatibility (use "openai" or "anthropic").',
    },
    {
      name: "invalid explicit provider ids",
      flags: {
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        providerId: "!!!",
      },
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
    },
  ])("rejects $name", ({ flags, expectedMessage }) => {
    expect(() => parseNonInteractiveCustomApiFlags(flags)).toThrow(expectedMessage);
  });
});
