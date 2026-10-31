// Onboard custom tests cover custom provider prompts and API-key credential handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { promptCustomApiConfig } from "./onboard-custom.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const loadManifestMetadataSnapshot = vi.hoisted(() => vi.fn(() => ({ plugins: [] })));
const discoveryFetch = vi.hoisted(() => vi.fn());
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: discoveryFetch,
}));
vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => {
  const { createEmptyPluginMetadataSnapshot } =
    await import("../plugins/plugin-metadata-empty.test-support.js");
  return {
    ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
    getCurrentPluginMetadataSnapshot: () => createEmptyPluginMetadataSnapshot(),
  };
});

// Keep host credentials outside the prompt flow while using the real credential helper.
vi.mock("../agents/model-auth-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-auth-env.js")>()),
  resolveEnvApiKey: () => null,
}));

function queuedAnswers<T>(answers: T[] = [], fallback?: T) {
  const mock = vi.fn().mockResolvedValue(fallback);
  for (const answer of answers) {
    mock.mockResolvedValueOnce(answer);
  }
  return mock;
}

function createTestPrompter(params: { text: string[]; select?: string[]; confirm?: boolean[] }) {
  return {
    ...createWizardPrompter(),
    text: queuedAnswers(params.text),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    select: queuedAnswers(params.select ?? ["plaintext", "openai"]),
    confirm: queuedAnswers(params.confirm, false),
    note: vi.fn(),
  };
}

function mockDiscoveredModels(ids: string[] = []) {
  discoveryFetch.mockImplementation(async () => ({
    response: Response.json({ data: ids.map((id) => ({ id })) }),
    release: async () => {},
  }));
}

function stubFetchSequence(
  responses: Array<{ ok: boolean; status?: number }>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: response.ok,
      status: response.status,
      headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runPromptCustomApi(
  prompter: ReturnType<typeof createTestPrompter>,
  setup: Partial<
    Pick<
      Parameters<typeof promptCustomApiConfig>[0],
      "config" | "target" | "verification" | "setAsPrimary"
    >
  > = {},
) {
  return promptCustomApiConfig({
    prompter,
    runtime: createTestRuntime(),
    config: {},
    ...setup,
  });
}

describe("promptCustomApiConfig", () => {
  beforeEach(() => {
    discoveryFetch.mockReset();
    mockDiscoveredModels();
    loadManifestMetadataSnapshot.mockReset();
    loadManifestMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("validates HTTP endpoints before asking for credentials", async () => {
    const prompter = createTestPrompter({
      text: [],
      confirm: [true],
    });
    prompter.text.mockImplementationOnce(({ validate }) => {
      expect(prompter.select).not.toHaveBeenCalled();
      for (const baseUrl of ["ftp://localhost/v1", "file:///tmp/model", "not-a-url"]) {
        expect(validate(baseUrl)).toMatch(/HTTP.*HTTPS/);
      }
      expect(validate("http://localhost:11434/v1")).toBeUndefined();
      expect(validate("https://provider.example/v1")).toBeUndefined();
      return "http://localhost:11434/v1";
    });
    for (const answer of ["", "llama3", "custom", ""]) {
      prompter.text.mockResolvedValueOnce(answer);
    }

    await runPromptCustomApi(prompter, { verification: "deferred" });
  });

  it("offers no-auth mode when the API key is left blank", async () => {
    const prompter = createTestPrompter({
      text: ["https://studio.example.ts.net/v1", "", "qwen3.8", "custom", ""],
      confirm: [true],
    });
    stubFetchSequence([]);

    const result = await runPromptCustomApi(prompter, { verification: "deferred" });

    expect(prompter.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("no-auth") }),
    );
    expect(result.config.models?.providers?.custom).toMatchObject({ auth: "none" });
    expect(result.config.models?.providers?.custom?.apiKey).toBeUndefined();
  });

  it("re-prompts for a key when no-auth mode is declined", async () => {
    const prompter = createTestPrompter({
      text: ["https://provider.example/v1", "", "real-key", "model-x", "custom", ""],
      select: ["plaintext", "plaintext", "openai"],
      confirm: [false],
    });
    stubFetchSequence([]);

    const result = await runPromptCustomApi(prompter, { verification: "deferred" });

    expect(result.config.models?.providers?.custom?.apiKey).toBe("real-key");
    expect(result.config.models?.providers?.custom?.auth).toBeUndefined();
  });

  it.each([
    { baseUrl: "https://claude-compatible.example.ts.net", compatibility: "anthropic" },
    { baseUrl: "https://resource.openai.azure.com", compatibility: "openai" },
  ])("requires a key for the effective adapter at $baseUrl", async ({ baseUrl, compatibility }) => {
    const prompter = createTestPrompter({
      text: [baseUrl, "", "qwen3.8", "custom", "", "placeholder-key"], // pragma: allowlist secret
      select: ["plaintext", compatibility, "plaintext"],
      confirm: [true, true],
    });
    stubFetchSequence([]);

    const result = await runPromptCustomApi(prompter, { verification: "deferred" });

    expect(result.config.models?.providers?.custom?.apiKey).toBe("placeholder-key"); // pragma: allowlist secret
    expect(result.config.models?.providers?.custom?.auth).toBeUndefined();
  });

  it("prepares deferred setup without an inference request or a selected default", async () => {
    const prompter = createTestPrompter({
      text: ["https://provider.example/v1", "fixture-key", "fixture-model", "custom", ""],
      select: ["plaintext", "openai-responses"],
    });
    const fetchMock = stubFetchSequence([]);
    const config = {};

    const result = await runPromptCustomApi(prompter, {
      config,
      verification: "deferred",
      setAsPrimary: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.config.models?.providers?.custom).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://provider.example/v1",
      models: [expect.objectContaining({ id: "fixture-model" })],
    });
    expect(result.config.agents?.defaults?.model).toBeUndefined();
    expect(config).toEqual({});
  });

  it("selects an advertised model during deferred custom setup", async () => {
    mockDiscoveredModels(["local-small", "local-large"]);
    const prompter = createTestPrompter({
      text: ["http://localhost:1234/v1", "fixture-key", "custom", ""],
      select: ["plaintext", "openai", "local-large"],
    });

    const result = await runPromptCustomApi(prompter, { verification: "deferred" });

    expect(result.config.models?.providers?.custom?.models.map((model) => model.id)).toEqual([
      "local-large",
    ]);
    expect(discoveryFetch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        init: { headers: { Authorization: "Bearer fixture-key" } },
      }),
    );
  });

  it("keeps manual model entry available when discovery succeeds", async () => {
    mockDiscoveredModels(["advertised-model"]);
    const prompter = createTestPrompter({
      text: ["http://localhost:1234/v1", "", "unlisted-model", "custom", ""],
      select: ["plaintext", "openai-responses", ""],
    });
    const result = await runPromptCustomApi(prompter, { verification: "deferred" });
    expect(result.modelId).toBe("unlisted-model");
  });

  it.each(["empty", "invalid", "http", "timeout"])(
    "explains manual entry after %s discovery",
    async (failure) => {
      discoveryFetch.mockImplementation(async () => {
        if (failure === "timeout") {
          throw new DOMException("Timed out", "TimeoutError");
        }
        return {
          response:
            failure === "http"
              ? new Response(null, { status: 401 })
              : failure === "invalid"
                ? new Response("not JSON")
                : Response.json({ data: [] }),
          release: async () => {},
        };
      });
      const prompter = createTestPrompter({
        text: ["http://localhost:1234/v1", "", "manual-model", "custom", ""],
      });
      const result = await runPromptCustomApi(prompter, { verification: "deferred" });
      expect(result.modelId).toBe("manual-model");
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("enter a model ID manually"),
        "Model ID",
      );
    },
  );

  it("keeps Anthropic setup on manual entry", async () => {
    const prompter = createTestPrompter({
      text: ["https://provider.example", "fixture-key", "claude-model", "custom", ""],
      select: ["plaintext", "anthropic"],
    });
    const result = await runPromptCustomApi(prompter, { verification: "deferred" });
    expect(result.modelId).toBe("claude-model");
    expect(discoveryFetch).not.toHaveBeenCalled();
  });

  it("threads one workspace-scoped manifest snapshot through alias validation", async () => {
    const preparedPlugins = [
      {
        modelIdNormalization: { providers: { custom: { aliases: { latest: "modern-model" } } } },
      },
    ];
    loadManifestMetadataSnapshot.mockReturnValueOnce({ plugins: preparedPlugins } as never);
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "modern-model", "custom", "Legacy"],
    });
    stubFetchSequence([{ ok: true }]);
    const config = {
      agents: {
        entries: { ops: { models: { "openai/ops": { alias: "Operations" } } } },
        defaults: {
          models: {
            "custom/latest": { alias: "Legacy" },
          },
        },
      },
    };
    const target = {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      workspaceDir: "/tmp/ops-workspace",
    };

    const result = await runPromptCustomApi(prompter, { config, target });

    expect(loadManifestMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: target.workspaceDir }),
    );
    const aliasPrompt = prompter.text.mock.calls.find(
      ([options]) => options.message === "Model alias (optional)",
    );
    expect(aliasPrompt?.[0].validate("Operations")).toBe(
      "Alias Operations already points to openai/ops.",
    );
    expect(result.config.agents?.defaults?.models?.["custom/modern-model"]?.alias).toBe("Legacy");
  });

  it.each(["HTML", "HTTP error"])(
    "retries %s verification and cancels the successful response body",
    async (failure) => {
      const prompter = createTestPrompter({
        text: [
          "https://proxy.example.com",
          "test-key",
          "bad-model",
          "https://proxy.example.com/v1",
          "test-key",
          "custom",
          "",
        ],
        select: ["plaintext", "openai", "baseUrl", "plaintext"],
      });
      const cancel = vi.fn(async () => undefined);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: failure === "HTML",
          status: failure === "HTML" ? 200 : 400,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          body: { cancel },
        });
      vi.stubGlobal("fetch", fetchMock);

      await runPromptCustomApi(prompter);

      expect(prompter.progress.mock.results[0]?.value.stop).toHaveBeenCalledWith(
        expect.stringContaining(failure === "HTML" ? "usually need a /v1 path prefix" : "400"),
      );
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://proxy.example.com/chat/completions");
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://proxy.example.com/v1/chat/completions");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

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
    stubFetchSequence([
      { ok: false, status: 404 },
      { ok: false, status: 404 },
      { ok: false, status: 404 },
      { ok: true },
    ]);
    await runPromptCustomApi(prompter);

    expect(prompter.note).toHaveBeenCalledWith(
      "This endpoint did not respond to OpenAI Chat, OpenAI Responses, or Anthropic style requests.",
      "Endpoint detection",
    );
  });

  it("aborts verification after timeout", async () => {
    vi.useFakeTimers();
    const requestStarted = Promise.withResolvers<void>();
    const prompter = createTestPrompter({
      text: ["http://localhost:11434/v1", "", "slow-model", "fast-model", "custom", ""],
      select: ["plaintext", "openai", "model"],
    });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        requestStarted.resolve();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        });
      })
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPromptCustomApi(prompter);

    await requestStarted.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(prompter.text).toHaveBeenCalledTimes(6);
  });
});
