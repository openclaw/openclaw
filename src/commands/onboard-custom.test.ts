import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import type { OpenClawConfig } from "../config/config.js";
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

/**
 * URL-aware fetch mock for custom API config tests.
 * Requests ending with `/models` are treated as model discovery;
 * everything else consumes from the verificationResponses queue.
 */
function stubFetchForCustomApi(params: {
  discoveryModels?: Array<{ id: string; owned_by?: string }>;
  verificationResponses: Array<{ ok: boolean; status?: number }>;
}): ReturnType<typeof vi.fn> {
  const discoveryModels = params.discoveryModels ?? [];
  const verificationQueue = [...params.verificationResponses];

  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.endsWith("/models")) {
      if (discoveryModels.length === 0) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: discoveryModels }),
      });
    }
    const response = verificationQueue.shift();
    return Promise.resolve({
      ok: response?.ok ?? false,
      status: response?.status ?? 500,
      json: async () => ({}),
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Filter fetch mock calls to only verification/probe requests (excludes /models discovery). */
function filterVerificationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([url]: unknown[]) => typeof url !== "string" || !url.endsWith("/models"),
  );
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

function buildCustomProviderConfig(contextWindow?: number) {
  if (contextWindow === undefined) {
    return {} as OpenClawConfig;
  }
  return {
    models: {
      providers: {
        custom: {
          api: "openai-completions" as const,
          baseUrl: "https://llm.example.com/v1",
          models: [
            {
              id: "foo-large",
              name: "foo-large",
              contextWindow,
              maxTokens: contextWindow > CONTEXT_WINDOW_HARD_MIN_TOKENS ? 4096 : 1024,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

function applyCustomModelConfigWithContextWindow(contextWindow?: number) {
  return applyCustomApiConfig({
    config: buildCustomProviderConfig(contextWindow),
    baseUrl: "https://llm.example.com/v1",
    modelId: "foo-large",
    compatibility: "openai",
    providerId: "custom",
  });
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
    stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, textCalls: 5, selectCalls: 2, result });
    expect(result.config.agents?.defaults?.models?.["custom/llama3"]?.alias).toBe("local");
  });

  it("retries when verification fails", async () => {
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "bad-model", "good-model", "custom", ""],
      select: ["plaintext", "openai", "model"],
    });
    stubFetchForCustomApi({
      verificationResponses: [{ ok: false, status: 400 }, { ok: true }],
    });
    await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledTimes(6);
    expect(prompter.select).toHaveBeenCalledTimes(3);
  });

  it("detects openai compatibility when unknown", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "unknown"],
    });
    stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, textCalls: 5, selectCalls: 2, result });
  });

  it("uses expanded max_tokens for openai verification probes", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "openai"],
    });
    const fetchMock = stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });

    await runPromptCustomApi(prompter);

    const verifyCalls = filterVerificationCalls(fetchMock);
    const firstCall = verifyCalls[0]?.[1] as { body?: string } | undefined;
    expect(firstCall?.body).toBeDefined();
    expect(JSON.parse(firstCall?.body ?? "{}")).toMatchObject({ max_tokens: 1 });
  });

  it("uses azure-specific headers and body for openai verification probes", async () => {
    const prompter = createTestPrompter({
      text: [
        "https://my-resource.openai.azure.com",
        "azure-test-key",
        "gpt-4.1",
        "custom",
        "alias",
      ],
      select: ["plaintext", "openai"],
    });
    const fetchMock = stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });

    await runPromptCustomApi(prompter);

    const verifyCalls = filterVerificationCalls(fetchMock);
    const firstCall = verifyCalls[0];
    const firstUrl = firstCall?.[0];
    const firstInit = firstCall?.[1] as
      | { body?: string; headers?: Record<string, string> }
      | undefined;
    if (typeof firstUrl !== "string") {
      throw new Error("Expected first verification call URL");
    }
    const parsedBody = JSON.parse(firstInit?.body ?? "{}");

    expect(firstUrl).toContain("/openai/deployments/gpt-4.1/chat/completions");
    expect(firstUrl).toContain("api-version=2024-10-21");
    expect(firstInit?.headers?.["api-key"]).toBe("azure-test-key");
    expect(firstInit?.headers?.Authorization).toBeUndefined();
    expect(firstInit?.body).toBeDefined();
    expect(parsedBody).toMatchObject({
      messages: [{ role: "user", content: "Hi" }],
      max_completion_tokens: 5,
      stream: false,
    });
    expect(parsedBody).not.toHaveProperty("model");
    expect(parsedBody).not.toHaveProperty("max_tokens");
  });

  it("uses expanded max_tokens for anthropic verification probes", async () => {
    const prompter = createTestPrompter({
      text: ["https://example.com", "test-key", "detected-model", "custom", "alias"],
      select: ["plaintext", "unknown"],
    });
    const fetchMock = stubFetchForCustomApi({
      verificationResponses: [{ ok: false, status: 404 }, { ok: true }],
    });

    await runPromptCustomApi(prompter);

    const verifyCalls = filterVerificationCalls(fetchMock);
    expect(verifyCalls).toHaveLength(2);
    const secondCall = verifyCalls[1]?.[1] as { body?: string } | undefined;
    expect(secondCall?.body).toBeDefined();
    expect(JSON.parse(secondCall?.body ?? "{}")).toMatchObject({ max_tokens: 1 });
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
    stubFetchForCustomApi({
      verificationResponses: [{ ok: false, status: 404 }, { ok: false, status: 404 }, { ok: true }],
    });
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
    stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });
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

    let verificationCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
      if (typeof url === "string" && url.endsWith("/models")) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      verificationCallCount++;
      if (verificationCallCount === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPromptCustomApi(prompter);

    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(prompter.text).toHaveBeenCalledTimes(6);
  });

  it("stores env SecretRef for custom provider when selected", async () => {
    vi.stubEnv("CUSTOM_PROVIDER_API_KEY", "test-env-key");
    const prompter = createTestPrompter({
      text: ["https://example.com/v1", "CUSTOM_PROVIDER_API_KEY", "detected-model", "custom", ""],
      select: ["ref", "env", "openai"],
    });
    const fetchMock = stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });

    const result = await runPromptCustomApi(prompter);

    expect(result.config.models?.providers?.custom?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_PROVIDER_API_KEY",
    });
    const verifyCalls = filterVerificationCalls(fetchMock);
    const firstVerification = verifyCalls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(firstVerification?.headers?.Authorization).toBe("Bearer test-env-key");
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
    stubFetchForCustomApi({ verificationResponses: [{ ok: true }] });

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

  it("discovers models and lets user select from list", async () => {
    const prompter = createTestPrompter({
      // modelId is selected via prompter.select, not text
      text: ["https://custom-llm.example.com/v1", "test-key", "custom", ""],
      select: ["plaintext", "openai", "gpt-4o"],
    });
    stubFetchForCustomApi({
      discoveryModels: [
        { id: "gpt-4o", owned_by: "openai" },
        { id: "gpt-4o-mini", owned_by: "openai" },
      ],
      verificationResponses: [{ ok: true }],
    });
    const result = await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledTimes(4);
    expect(prompter.select).toHaveBeenCalledTimes(3);
    expect(result.modelId).toBe("gpt-4o");
    expect(result.config.models?.providers?.custom?.api).toBe("openai-completions");
  });

  it("falls back to manual input when user selects manual option from discovered list", async () => {
    const prompter = createTestPrompter({
      text: ["https://custom-llm.example.com/v1", "test-key", "my-custom-model", "custom", ""],
      select: ["plaintext", "openai", "__manual_input__"],
    });
    stubFetchForCustomApi({
      discoveryModels: [{ id: "gpt-4o" }],
      verificationResponses: [{ ok: true }],
    });
    const result = await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledTimes(5);
    expect(prompter.select).toHaveBeenCalledTimes(3);
    expect(result.modelId).toBe("my-custom-model");
  });
});

describe("applyCustomApiConfig", () => {
  it.each([
    {
      name: "uses hard-min context window for newly added custom models",
      existingContextWindow: undefined,
      expectedContextWindow: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    },
    {
      name: "upgrades existing custom model context window when below hard minimum",
      existingContextWindow: 4096,
      expectedContextWindow: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    },
    {
      name: "preserves existing custom model context window when already above minimum",
      existingContextWindow: 131072,
      expectedContextWindow: 131072,
    },
  ])("$name", ({ existingContextWindow, expectedContextWindow }) => {
    const result = applyCustomModelConfigWithContextWindow(existingContextWindow);
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );
    expect(model?.contextWindow).toBe(expectedContextWindow);
  });

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
      apiKey: "custom-test-key", // pragma: allowlist secret
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
