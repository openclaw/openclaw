import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import type { ProviderStreamOptions } from "../llm/types.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  API_KEY_FIELD,
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
  getApiKeyForModelMock,
  resolveApiKeyForProviderCoreMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  resolveModelAsyncMock,
  unwrapSecretSentinelsForProviderEgressMock,
  registerProviderStreamForModelMock,
} = imageRuntimeMocks;

const {
  describeImageWithModelCore,
  describeImagesWithModelCore,
  describeImageWithModelPayloadTransformCore,
} = await import("./image.js");
const imageModelRuntime = await import("./image-model-runtime.js");
type ImageRequest = Parameters<typeof describeImageWithModelCore>[0];
const openai = { provider: "openai", model: "gpt-5.4-mini" };
const minimax = { provider: "minimax-portal", model: "MiniMax-VL-01" };
function request(ref = openai, overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { ...imageRequestDefaults(), ...ref, ...overrides };
}
function mockOpenAi() {
  mockImageModel({
    provider: openai.provider,
    id: openai.model,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
}
function openAiCompletion(text: string) {
  return imageCompletion("openai-responses", openai.provider, openai.model, text);
}
const opencode = {
  provider: "opencode-go",
  model: "gemini-3-flash",
  baseUrl: "https://opencode.ai/zen/go/v1",
};
const sessionHeader = "x-opencode-session";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opencodeCompletion = () =>
  imageCompletion("openai-completions", opencode.provider, opencode.model, "vision ok");
function stubProviderStream(result = vi.fn(async () => opencodeCompletion())) {
  const stream = vi.fn((_model: unknown, _context: unknown, _options: ProviderStreamOptions) => ({
    result,
  }));
  registerProviderStreamForModelMock.mockReturnValue(stream);
  return {
    stream,
    options: (index: number) => {
      const options = expectDefined(
        stream.mock.calls.at(index),
        `provider stream call ${index}`,
      )[2];
      return { sessionId: options.sessionId, header: options.headers?.[sessionHeader] };
    },
  };
}
function requestOpencode() {
  mockImageModel({
    provider: opencode.provider,
    id: opencode.model,
    api: "openai-completions",
    baseUrl: opencode.baseUrl,
  });
  return describeImageWithModelCore(request(opencode));
}
function mockUnknownMinimax() {
  resolveModelAsyncMock.mockResolvedValue({
    authStorage: preparedAuthStorage,
    modelRegistry: { find: vi.fn(() => null) },
    error: "Unknown model: minimax-cn/MiniMax-VL-01",
  });
}
type Providers = NonNullable<NonNullable<ImageRequest["cfg"]["models"]>["providers"]>;
async function describeCn(providers: Providers, workspaceDir?: string) {
  const cfg = { models: { providers } };
  await expect(
    describeImageWithModelCore(
      request({ ...minimax, provider: "minimax-cn" }, { cfg, workspaceDir }),
    ),
  ).resolves.toEqual({ text: "portal ok", model: "MiniMax-VL-01" });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.minimaxi.com/v1/coding_plan/vlm");
}

describe("describeImageWithModelCore", () => {
  installImageRuntimeTestHooks({ apiKey: "test-api-key" });

  it("surfaces provider errors from image-model responses", async () => {
    mockOpenAi();
    completeMock.mockResolvedValue({
      ...openAiCompletion(""),
      stopReason: "error",
      errorMessage: "boom",
    });
    await expect(describeImageWithModelCore(request())).rejects.toThrow(/boom/i);
    expect(completeMock).toHaveBeenCalledOnce();
  });

  it("returns trimmed text from image-model responses", async () => {
    const ref = { provider: "anthropic", model: "claude-opus-4-6" };
    mockImageModel({ provider: ref.provider, id: ref.model, api: "anthropic-messages" });
    completeMock.mockResolvedValue(
      imageCompletion("anthropic-messages", ref.provider, ref.model, "  hello  "),
    );
    await expect(describeImageWithModelCore(request(ref))).resolves.toEqual({
      text: "hello",
      model: ref.model,
    });
  });

  it.each([
    ["reasoning_content", "reasoning_content", true, 0],
    ["Responses JSON", JSON.stringify({ id: "rs_123", type: "reasoning" }), true, 0],
    ["Responses object", { id: "rs_456", type: "reasoning.encrypted" }, true, 0],
    [
      "oversized Responses JSON",
      JSON.stringify({
        id: "rs_123",
        summary: [{ text: "x".repeat(2_100) }],
        type: "reasoning",
      }),
      true,
      0,
    ],
    ["signature after bounded block scan", "reasoning_content", false, 50],
  ] as const)(
    "retries image reasoning-only responses: %s",
    async (_name, signature, retry, precedingBlocks) => {
      mockOpenAi();
      const completion = openAiCompletion("retry ok");
      completeMock
        .mockResolvedValueOnce({
          ...completion,
          content: [
            ...Array.from({ length: precedingBlocks }, () => ({
              type: "thinking",
              thinking: "untagged",
            })),
            {
              type: "thinking",
              thinking: "  <think>private</think> maybe a cat  ",
              thinkingSignature: signature,
            },
          ],
        })
        .mockResolvedValueOnce(completion);
      const result = describeImageWithModelCore(request());
      if (retry) {
        await expect(result).resolves.toEqual({ text: "retry ok", model: openai.model });
      } else {
        await expect(result).rejects.toThrow(/returned no text/i);
      }
      expect(completeMock).toHaveBeenCalledTimes(retry ? 2 : 1);
    },
  );

  it.each([
    { modelMaxTokens: undefined, requested: undefined, expected: 4096 },
    { modelMaxTokens: 1024.5, requested: 2048, expected: 1024.5 },
    { modelMaxTokens: Number.NaN, requested: -0, expected: -0 },
    { modelMaxTokens: 0, requested: 0.5, expected: 0.5 },
  ])(
    "preserves image completion token caps %#",
    async ({ modelMaxTokens, requested, expected }) => {
      mockImageModel({
        provider: openai.provider,
        id: openai.model,
        api: "openai-responses",
        maxTokens: modelMaxTokens,
      });
      completeMock.mockResolvedValue(openAiCompletion("ok"));
      await describeImageWithModelCore(request(openai, { maxTokens: requested }));
      expect(completeMock).toHaveBeenCalledOnce();
      const options = expectDefined(completeMock.mock.calls[0], "image cap completion")[2];
      expect(options.maxTokens).toBe(expected);
    },
  );

  it("uses a fresh routing identity for each image request", async () => {
    const { options } = stubProviderStream();
    await requestOpencode();
    await requestOpencode();
    const first = options(0);
    const second = options(1);
    const expected = { sessionId: undefined, header: expect.stringMatching(uuidPattern) };
    expect([first, second]).toEqual([expected, expected]);
    expect(first.header).not.toBe(second.header);
  });

  it("reuses one routing identity across the reasoning-only retry", async () => {
    const { stream, options } = stubProviderStream(
      vi
        .fn()
        .mockResolvedValueOnce({
          ...opencodeCompletion(),
          content: [
            {
              type: "thinking",
              thinking: "examining the image",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce(opencodeCompletion()),
    );
    await requestOpencode();
    expect(stream).toHaveBeenCalledTimes(2);
    const first = options(0).header;
    expect(first).toMatch(uuidPattern);
    expect(options(1).header).toBe(first);
  });

  it("does not start another MiniMax request after caller cancellation", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled MiniMax image batch"));
      return Response.json({ base_resp: { status_code: 0 }, content: "first image" });
    });

    await expect(
      describeImagesWithModelCore({
        ...request(minimax),
        images: [
          { buffer: Buffer.from("first"), fileName: "first.png", mime: "image/png" },
          { buffer: Buffer.from("second"), fileName: "second.png", mime: "image/png" },
        ],
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
          { proxy: { mode: "explicit-proxy", url: "https://proxy.example.com" } },
        ),
      ),
    });

    await describeImageWithModelCore(request(minimax));

    expect(imageTestFetchWithSsrFGuardMock.mock.calls[0]?.[0]?.dispatcherPolicy).toEqual({
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

    await describeImageWithModelCore(request(minimax));

    expect(unwrapSecretSentinelsForProviderEgressMock).toHaveBeenCalledWith(
      sentinelValue,
      "MiniMax VLM request",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
  });

  it("describes images keyless when amazon-bedrock resolves aws-sdk auth", async () => {
    const bedrock = { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-4-6-v1" };
    const api = "bedrock-converse-stream";
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: "",
      source: "profile:amazon-bedrock:default",
      mode: "aws-sdk",
    });
    // An empty key must bypass the normal key-required boundary.
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
      provider: bedrock.provider,
      id: bedrock.model,
      api,
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    });
    completeMock.mockResolvedValue(
      imageCompletion(api, bedrock.provider, bedrock.model, "an orange tabby cat"),
    );

    const result = await describeImageWithModelCore(request(bedrock));
    expect(result).toEqual({ text: "an orange tabby cat", model: bedrock.model });
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(completeMock.mock.calls[0]?.[2]).toMatchObject({ apiKey: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["canonical", "secret-ref", "global-url"] as const)(
    "resolves MiniMax CN fallback with %s configuration",
    async (mode) => {
      mockUnknownMinimax();
      const alias = mode === "secret-ref";
      const provider = alias ? "minimax-cn" : "minimax";
      const workspaceDir = mode === "canonical" ? "/tmp/openclaw-workspace" : undefined;
      const apiKey: Providers[string]["apiKey"] = alias
        ? { source: "file", provider: "default", id: "/providers/minimax-cn/apiKey" }
        : mode === "canonical"
          ? "test-api-key"
          : undefined;
      await describeCn(
        {
          [provider]: {
            baseUrl:
              mode === "global-url"
                ? "https://api.minimax.io/anthropic"
                : "https://api.minimaxi.com/anthropic",
            models: [],
            ...(apiKey ? { apiKey } : {}),
          },
        },
        workspaceDir,
      );
      if (mode !== "global-url") {
        expect(resolveApiKeyForProviderCoreMock).toHaveBeenCalledWith(
          expect.objectContaining({
            provider,
            ...(workspaceDir ? { agentDir: "/tmp/openclaw-agent", workspaceDir } : {}),
          }),
        );
      }
    },
  );
});

describe("image runtime cancellation and retries", () => {
  installImageRuntimeTestHooks();

  it.each([
    { asyncTransform: false, replace: true },
    { asyncTransform: true, replace: false },
  ])(
    "applies caller transforms after retry stripping ($asyncTransform, $replace)",
    async ({ asyncTransform, replace }) => {
      mockOpenAi();
      const completion = openAiCompletion("retry ok");
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
          content: [{ type: "thinking", thinking: "x", thinkingSignature: "reasoning_content" }],
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
        describeImageWithModelPayloadTransformCore(request(), transform),
      ).resolves.toEqual({ text: "retry ok", model: "gpt-5.4-mini" });
      expect(transform).toHaveBeenCalledOnce();
    },
  );

  it("does not start the reasoning-only retry after caller cancellation", async () => {
    const controller = new AbortController();
    mockOpenAi();
    completeMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled image description"));
      return {
        ...openAiCompletion(""),
        content: [{ type: "thinking", thinking: "internal", thinkingSignature: "reasoning" }],
      };
    });

    await expect(
      describeImageWithModelCore(request(openai, { signal: controller.signal })),
    ).rejects.toThrow("caller cancelled image description");

    expect(completeMock).toHaveBeenCalledOnce();
    const options = expectDefined(
      completeMock.mock.calls[0],
      "cancelled image completion call 0",
    )[2];
    expect(options?.signal?.aborted).toBe(true);
  });

  it("retains the prepared runtime until an aborted provider actually settles", async () => {
    mockOpenAi();
    const completion = createDeferred();
    completeMock.mockImplementation(async () => {
      await completion.promise;
      throw new Error("late provider failure");
    });
    const controller = new AbortController();
    const result = describeImageWithModelCore(
      request(openai, { timeoutMs: 60_000, signal: controller.signal }),
    );

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
    mockOpenAi();
    const resolveModel = expectDefined(
      resolveModelAsyncMock.getMockImplementation(),
      "model resolver",
    );
    resolveModelAsyncMock.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, slowSetupMs);
      });
      return resolveModel(...args);
    });
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModelCore(request());

    await vi.advanceTimersByTimeAsync(slowSetupMs);
    await Promise.resolve();
    expect(completeMock).toHaveBeenCalledTimes(1);
    const options = expectDefined(completeMock.mock.calls[0], "slow setup completion")[2];
    const signal = expectDefined(options?.signal, "image completion abort signal");
    expect(options.timeoutMs).toBe(1000);

    const assertion = expect(result).rejects.toThrow(
      `image description request timed out after 1000ms (setup took ${slowSetupMs}ms before provider request started)`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(signal.aborted).toBe(true);
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
          provider: "openai",
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
        describeImageWithModelCore(request(openai, { timeoutMs: 25, signal: controller.signal })),
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
