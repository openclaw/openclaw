import { expectDefined } from "@openclaw/normalization-core/expect";
// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  API_KEY_FIELD,
  SET_RUNTIME_API_KEY_FIELD,
  imageRuntimeMocks,
  imageRequestDefaults,
  mockImageModel,
  imageCompletion,
  imageTestFetchWithSsrFGuardMock,
  installImageRuntimeTestHooks,
  preparedAuthStorage,
} from "./image.test-support.js";

const {
  completeMock,
  acquireAgentRunPreparedModelRuntimeMock,
  shouldPreferProviderRuntimeResolvedModelMock,
  prepareProviderRuntimeAuthMock,
  releasePreparedModelRuntimeMock,
  resolveModelWithRegistryMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderCoreMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  resolveModelAsyncMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = imageRuntimeMocks;

const requireRecord = createRequireRecord("record", "expected-label-capitalized");
const {
  describeImageWithModelCore,
  describeImagesWithModelCore,
  describeImageWithModelPayloadTransformCore,
} = await import("./image.js");
const imageModelRuntime = await import("./image-model-runtime.js");

describe("describeImageWithModelCore", () => {
  installImageRuntimeTestHooks({ apiKey: "test-api-key" });

  it("does not start another MiniMax request after caller cancellation", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled MiniMax image batch"));
      return Response.json({
        base_resp: { status_code: 0 },
        content: "first image",
      });
    });

    await expect(
      describeImagesWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
        images: [
          { buffer: Buffer.from("first"), fileName: "first.png", mime: "image/png" },
          { buffer: Buffer.from("second"), fileName: "second.png", mime: "image/png" },
        ],
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled MiniMax image batch");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("carries resolved MiniMax model transport policy into the VLM request", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() =>
        attachModelProviderRequestTransport(
          {
            provider: "minimax-portal",
            id: "MiniMax-VL-01",
            input: ["text", "image"],
            baseUrl: "https://custom-minimax.example.com/anthropic",
          },
          {
            proxy: { mode: "explicit-proxy", url: "https://proxy.example.com" },
          },
        ),
      ),
    });

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
    });

    const guardedOptions = requireRecord(
      expectDefined(imageTestFetchWithSsrFGuardMock.mock.calls[0], "guarded fetch call 0")[0],
      "guarded fetch options",
    );
    expect(guardedOptions.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "https://proxy.example.com",
    });
  });

  it("unwraps a sentinel only at the direct MiniMax VLM handoff", async () => {
    const sentinelValue = mintSecretSentinel("test-api-key", { label: "test:minimax" });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: sentinelValue,
      source: "test",
      mode: "api-key",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce("test-token");

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
    });

    expect(unwrapSecretSentinelsForProviderEgressMock).toHaveBeenCalledWith(
      sentinelValue,
      "MiniMax VLM request",
    );
    const [, fetchOptionsValue] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(new Headers(fetchOptions.headers as HeadersInit).get("Authorization")).toBe(
      ["Bearer", "test-token"].join(" "),
    );
  });

  it("describes images keyless when amazon-bedrock resolves aws-sdk auth", async () => {
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: "",
      source: "profile:amazon-bedrock:default",
      mode: "aws-sdk",
    });
    // Faithful to runtime: requireApiKey throws on an empty resolved key. The
    // aws-sdk carve-out must return before reaching it.
    requireApiKeyMock.mockImplementation((auth: { apiKey?: string; mode?: string }) => {
      const key = auth.apiKey?.trim();
      if (!key) {
        throw new Error(
          `No API key resolved for provider "amazon-bedrock" (auth mode: ${auth.mode}).`,
        );
      }
      return key;
    });
    mockImageModel({
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-6-v1",
      api: "bedrock-converse-stream",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    });
    completeMock.mockResolvedValue(
      imageCompletion(
        "bedrock-converse-stream",
        "amazon-bedrock",
        "us.anthropic.claude-sonnet-4-6-v1",
        "an orange tabby cat",
      ),
    );

    const result = await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-6-v1",
      prompt: "Describe the image.",
    });

    expect(result).toEqual({
      text: "an orange tabby cat",
      model: "us.anthropic.claude-sonnet-4-6-v1",
    });
    // The carve-out returns before requireApiKey and skips persisting an
    // empty-string secret; the empty key flows through to the model runtime.
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).not.toHaveBeenCalled();
    const completeCall = expectDefined(completeMock.mock.calls[0], "complete call 0");
    expect(requireRecord(completeCall[2], "stream options").apiKey).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes workspaceDir through MiniMax VLM fallback auth", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-portal/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
        prompt: "Describe the image.",
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-portal",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses canonical MiniMax CN baseUrl for VLM alias fallback", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        cfg: {
          models: {
            providers: {
              minimax: {
                [API_KEY_FIELD]: "test-api-key",
                baseUrl: "https://api.minimaxi.com/anthropic",
                models: [],
              },
            },
          },
        },
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        prompt: "Describe the image.",
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax",
      }),
    );
    const [fetchUrl] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("uses MiniMax CN alias auth when the alias apiKey is a SecretRef", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        cfg: {
          models: {
            providers: {
              "minimax-cn": {
                [API_KEY_FIELD]: {
                  source: "file",
                  provider: "default",
                  id: "/providers/minimax-cn/apiKey",
                },
                baseUrl: "https://api.minimaxi.com/anthropic",
                models: [],
              },
            },
          },
        },
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        prompt: "Describe the image.",
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-cn",
      }),
    );
    const [fetchUrl] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });

  it("does not inherit global MiniMax baseUrl for CN VLM aliases", async () => {
    const authStorage = {
      [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-cn/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        cfg: {
          models: {
            providers: {
              minimax: { baseUrl: "https://api.minimax.io/anthropic", models: [] },
            },
          },
        },
        provider: "minimax-cn",
        model: "MiniMax-VL-01",
        prompt: "Describe the image.",
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    const [fetchUrl] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
    expect(fetchUrl).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
  });
});

describe("image runtime cancellation and retries", () => {
  installImageRuntimeTestHooks();

  it("reports the resolved model input when an image model is text-only", async () => {
    mockImageModel({
      provider: "lmstudio",
      id: "text-only",
      api: "openai-completions",
      input: ["text"],
      baseUrl: "http://127.0.0.1:1234",
    });

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        provider: "lmstudio",
        model: "text-only",
        prompt: "Describe the image.",
      }),
    ).rejects.toThrow(
      "Model does not support images: lmstudio/text-only (resolved lmstudio/text-only input: text)",
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it.each([
    { asyncTransform: false, replace: true },
    { asyncTransform: true, replace: false },
  ])(
    "applies caller transforms after retry stripping ($asyncTransform, $replace)",
    async ({ asyncTransform, replace }) => {
      // OpenAI picks its route from the credential, so the Platform route needs a Platform key.
      vi.stubEnv("OPENAI_API_KEY", "test-token");
      getApiKeyForModelMock.mockResolvedValue({
        apiKey: "test-token",
        source: "test",
        mode: "api-key",
      });
      mockImageModel({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        baseUrl: "https://api.openai.com/v1",
      });
      const completion = imageCompletion("openai-responses", "openai", "gpt-5.4-mini", "retry ok");
      const stripped = { reasoning: { effort: "none" } };
      const replacement = { custom: "provider option" };
      const transform = vi.fn((payload: unknown) => {
        expect(payload).toEqual(stripped);
        const result = replace ? replacement : undefined;
        return asyncTransform ? Promise.resolve(result) : result;
      });
      completeMock
        .mockResolvedValueOnce({
          ...completion,
          content: [
            {
              type: "thinking",
              thinking: "image reasoning",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockImplementationOnce(async (model, _context, options) => {
          const onPayload = expectDefined(options.onPayload, "retry payload transform");
          expect(
            await onPayload(
              { reasoning_effort: "high", include: ["reasoning.encrypted_content"] },
              model,
            ),
          ).toEqual(replace ? replacement : stripped);
          return completion;
        });

      await expect(
        describeImageWithModelPayloadTransformCore(
          {
            ...imageRequestDefaults(),
            provider: "openai",
            model: "gpt-5.4-mini",
          },
          transform,
        ),
      ).resolves.toEqual({ text: "retry ok", model: "gpt-5.4-mini" });
      expect(transform).toHaveBeenCalledOnce();
    },
  );

  it("does not start the reasoning-only retry after caller cancellation", async () => {
    const controller = new AbortController();
    mockImageModel({
      api: "openai-responses",
      provider: "acme",
      id: "gpt-5.4-mini",
      baseUrl: "https://llm.example.com/v1",
    });
    completeMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled image description"));
      return {
        role: "assistant",
        api: "openai-responses",
        provider: "acme",
        model: "gpt-5.4-mini",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "thinking", thinking: "internal", thinkingSignature: "reasoning" }],
      };
    });

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        provider: "acme",
        model: "gpt-5.4-mini",
        prompt: "Describe the image.",
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled image description");

    expect(completeMock).toHaveBeenCalledOnce();
    const options = expectDefined(
      completeMock.mock.calls[0],
      "cancelled image completion call 0",
    )[2];
    expect(options?.signal?.aborted).toBe(true);
  });

  it("rejects when a generic image completion ignores the abort signal", async () => {
    vi.useFakeTimers();
    mockImageModel({
      api: "openai-responses",
      provider: "acme",
      id: "gpt-5.4-mini",
      baseUrl: "https://llm.example.com/v1",
    });
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "acme",
      model: "gpt-5.4-mini",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow(
      "image description request timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    const firstCall = expectDefined(completeMock.mock.calls[0], "timed image completion call 0");
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.signal.aborted).toBe(true);
    expect(options.timeoutMs).toBe(25);
  });

  it("retains the prepared runtime until an aborted provider actually settles", async () => {
    mockImageModel({
      api: "openai-responses",
      provider: "acme",
      id: "gpt-5.4-mini",
      baseUrl: "https://llm.example.com/v1",
    });
    const completion = createDeferred();
    completeMock.mockImplementation(async () => {
      await completion.promise;
      throw new Error("late provider failure");
    });
    const controller = new AbortController();
    const result = describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "acme",
      model: "gpt-5.4-mini",
      prompt: "Describe the image.",
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    try {
      await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
      const assertion = expect(result).rejects.toThrow("caller cancelled provider request");
      controller.abort(new Error("caller cancelled provider request"));
      await assertion;

      expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();
    } finally {
      completion.resolve();
    }
    await vi.waitFor(() => expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce());
  });

  it("keeps the full configured timeout for provider requests after slow setup", async () => {
    vi.useFakeTimers();
    const slowSetupMs = 400;
    mockImageModel({
      api: "openai-responses",
      provider: "acme",
      id: "gpt-5.4-mini",
      baseUrl: "https://llm.example.com/v1",
    });
    resolveModelAsyncMock.mockImplementationOnce(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, slowSetupMs);
        });
        const authStorage = {
          [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
        };
        const modelRegistry = discoverModelsMock(authStorage, agentDir);
        const model = resolveModelWithRegistryMock({
          provider,
          modelId,
          modelRegistry,
          cfg,
          agentDir,
        });
        return { authStorage, model, modelRegistry };
      },
    );
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "acme",
      model: "gpt-5.4-mini",
      prompt: "Describe the image.",
    });

    await vi.advanceTimersByTimeAsync(slowSetupMs);
    await Promise.resolve();
    expect(completeMock).toHaveBeenCalledTimes(1);
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "slow setup image completion call 0",
    );
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.timeoutMs).toBe(1000);

    const assertion = expect(result).rejects.toThrow(
      `image description request timed out after 1000ms (setup took ${slowSetupMs}ms before provider request started)`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(options.signal.aborted).toBe(true);
  });

  it.each([
    { mode: "cancellation", stage: "admission", cleanupFails: false },
    { mode: "cancellation", stage: "model", cleanupFails: false },
    { mode: "cancellation", stage: "credential", cleanupFails: false },
    { mode: "timeout", stage: "credential-model", cleanupFails: true },
    { mode: "cancellation", stage: "runtime-auth", cleanupFails: false },
  ] as const)(
    "stops image setup after $mode during $stage (cleanup failure: $cleanupFails)",
    async ({ mode, stage, cleanupFails }) => {
      vi.useFakeTimers();
      const resolution = vi.spyOn(imageModelRuntime, "resolveImageRuntime");
      const cleanupError = new Error("late image runtime disposal failed");
      const cleanupStarted = createDeferred();
      const finishCleanup = createDeferred();
      releasePreparedModelRuntimeMock.mockImplementationOnce(async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        if (cleanupFails) {
          throw cleanupError;
        }
      });
      const started = createDeferred();
      const finish = createDeferred();
      const delay = async <T>(value: T): Promise<T> => {
        started.resolve();
        await finish.promise;
        return value;
      };
      const resolved = {
        authStorage: preparedAuthStorage,
        model: {
          provider: "acme",
          id: "gpt-5.4-mini",
          api: "openai-responses",
          input: ["text", "image"],
        },
        modelRegistry: {},
      };
      resolveModelAsyncMock.mockResolvedValue(resolved);
      shouldPreferProviderRuntimeResolvedModelMock.mockReturnValue(stage === "credential-model");
      if (stage === "admission") {
        acquireAgentRunPreparedModelRuntimeMock.mockImplementationOnce(() =>
          delay({
            snapshot: {
              agentDir: "/tmp/openclaw-agent",
              config: {},
              metadataSnapshot: createEmptyPluginMetadataSnapshot(),
              createStores: () => ({ authStorage: preparedAuthStorage, modelRegistry: {} }),
            },
            [Symbol.asyncDispose]: releasePreparedModelRuntimeMock,
          }),
        );
      } else if (stage === "model") {
        resolveModelAsyncMock.mockImplementationOnce(() => delay(resolved));
      } else if (stage === "credential") {
        getApiKeyForModelMock.mockImplementationOnce(() =>
          delay({ apiKey: "test-token", source: "test", mode: "oauth" }),
        );
      } else if (stage === "credential-model") {
        resolveModelAsyncMock
          .mockResolvedValueOnce(resolved)
          .mockImplementationOnce(() => delay(resolved));
      } else {
        prepareProviderRuntimeAuthMock.mockImplementationOnce(() =>
          delay({ apiKey: "prepared-test-token" }),
        );
      }
      const controller = new AbortController();
      const work = new AsyncWorkScope();
      const pending = work.track(() =>
        describeImageWithModelCore({
          ...imageRequestDefaults(),
          provider: "acme",
          model: "gpt-5.4-mini",
          prompt: "Describe the image.",
          timeoutMs: 25,
          signal: controller.signal,
        }),
      );
      const rejected = expect(pending).rejects.toThrow(
        mode === "timeout"
          ? "image description setup timed out after 25ms before provider request started"
          : "caller cancelled during setup",
      );
      await started.promise;
      if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(25);
      } else {
        controller.abort(new Error("caller cancelled during setup"));
      }
      await rejected;
      expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();
      const setup = resolution.mock.results[0]?.value;
      const producerFailure = expect(setup).rejects.toMatchObject({
        name: mode === "timeout" ? "AbortError" : "Error",
      });
      let drained = false;
      let drain: Promise<void> | undefined;
      try {
        finish.resolve();
        await producerFailure;
        await cleanupStarted.promise;
        drain = work.drain().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce();
        finishCleanup.resolve();
        await drain;
        expect(drained).toBe(true);
        const disposal = releasePreparedModelRuntimeMock.mock.results[0]!.value;
        if (cleanupFails) {
          await expect(disposal).rejects.toBe(cleanupError);
        } else {
          await expect(disposal).resolves.toBeUndefined();
        }
      } finally {
        finish.resolve();
        finishCleanup.resolve();
        await drain;
        await work.drain();
      }
      expect(resolveModelAsyncMock).toHaveBeenCalledTimes(
        stage === "admission" ? 0 : stage === "credential-model" ? 2 : 1,
      );
      expect(getApiKeyForModelMock).toHaveBeenCalledTimes(
        stage === "admission" || stage === "model" ? 0 : 1,
      );
      expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledTimes(
        stage === "runtime-auth" ? 1 : 0,
      );
      expect(setRuntimeApiKeyMock).not.toHaveBeenCalled();
      expect(completeMock).not.toHaveBeenCalled();
    },
  );
});
