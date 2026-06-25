/** Tests OpenAI-compatible image provider request building and response handling. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleImageGenerationProvider,
  type OpenAiCompatibleImageProviderOptions,
} from "./openai-compatible-image-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadlineMock,
  fetchWithTimeoutGuardedMock,
  isProviderApiKeyConfiguredMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  resolveProviderOperationRemainingTimeoutMsMock,
  resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => ({
    timeoutMs: params.timeoutMs,
    label: params.label,
  })),
  fetchWithTimeoutGuardedMock: vi.fn(),
  isProviderApiKeyConfiguredMock: vi.fn(() => true),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => {
    const request =
      typeof params.request === "object" && params.request !== null
        ? (params.request as Record<string, unknown>)
        : undefined;
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(params.allowPrivateNetwork ?? request?.allowPrivateNetwork),
      headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
      dispatcherPolicy: request ? { request } : undefined,
    };
  }),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs,
  ),
  resolveProviderOperationRemainingTimeoutMsMock: vi.fn(
    (params: { deadline: { timeoutMs?: number }; defaultTimeoutMs: number }) =>
      params.deadline.timeoutMs ?? params.defaultTimeoutMs,
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadline: createProviderOperationDeadlineMock,
  fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  resolveProviderOperationRemainingTimeoutMs: resolveProviderOperationRemainingTimeoutMsMock,
  resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
}));

function requireFirstRequestHeaders(mock: ReturnType<typeof vi.fn>): Headers {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected request call");
  }
  const [request] = call as [{ headers?: Headers }];
  if (!request) {
    throw new Error("expected request call");
  }
  const headers = request.headers;
  expect(headers).toBeInstanceOf(Headers);
  if (!headers) {
    throw new Error("expected request headers");
  }
  return headers;
}

function requireFirstCallArg(mock: ReturnType<typeof vi.fn>): unknown {
  const call = (mock.mock.calls as unknown as Array<[unknown] | undefined>)[0];
  const arg = call?.[0];
  if (!arg) {
    throw new Error("expected mock call argument");
  }
  return arg;
}

function createProvider(overrides: Partial<OpenAiCompatibleImageProviderOptions> = {}) {
  return createOpenAiCompatibleImageGenerationProvider({
    id: "sample",
    label: "Sample",
    defaultModel: "sample-image",
    models: ["sample-image"],
    defaultBaseUrl: "https://sample.example/v1",
    capabilities: {
      generate: { maxCount: 4, supportsSize: true },
      edit: { enabled: true, maxCount: 1, maxInputImages: 1, supportsSize: true },
      geometry: { sizes: ["1024x1024"] },
    },
    useConfiguredRequest: true,
    buildGenerateRequest: ({ req, model, count }) => ({
      kind: "json",
      body: {
        model,
        prompt: req.prompt,
        n: count,
        size: req.size ?? "1024x1024",
        response_format: "b64_json",
      },
    }),
    buildEditRequest: ({ req, inputImages, model, count }) => {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt);
      form.set("n", String(count));
      form.append(
        "image",
        new Blob([new Uint8Array(inputImages[0]?.buffer ?? Buffer.alloc(0))], {
          type: inputImages[0]?.mimeType ?? "image/png",
        }),
        inputImages[0]?.fileName ?? "image.png",
      );
      return { kind: "multipart", form };
    },
    ...overrides,
  });
}

function mockGeneratedResponse() {
  const release = vi.fn(async () => {});
  const payload = {
    data: [
      {
        b64_json: Buffer.from("image-bytes").toString("base64"),
        revised_prompt: "revised",
      },
    ],
  };
  postJsonRequestMock.mockResolvedValue({ response: { json: async () => payload }, release });
  postMultipartRequestMock.mockResolvedValue({ response: { json: async () => payload }, release });
  return release;
}

describe("OpenAI-compatible image provider helper", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    createProviderOperationDeadlineMock.mockClear();
    isProviderApiKeyConfiguredMock.mockClear();
    fetchWithTimeoutGuardedMock.mockReset();
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "provider-key" });
    resolveProviderHttpRequestConfigMock.mockClear();
    resolveProviderOperationRemainingTimeoutMsMock.mockClear();
    resolveProviderOperationTimeoutMsMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
  });

  it("builds provider metadata and delegates configuration checks", () => {
    const provider = createProvider();

    expect(provider.id).toBe("sample");
    expect(provider.label).toBe("Sample");
    expect(provider.defaultModel).toBe("sample-image");
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "sample",
      agentDir: "/tmp/agent",
    });
  });

  it("posts JSON generation requests and parses OpenAI-compatible image data", async () => {
    const release = mockGeneratedResponse();
    const provider = createProvider();

    const result = await provider.generateImage({
      provider: "sample",
      model: "custom-image",
      prompt: "draw a square",
      count: 2,
      size: "512x512",
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: {
        models: {
          providers: {
            sample: {
              baseUrl: "https://sample.example/v1/",
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
    } as never);

    const apiKeyParams = requireFirstCallArg(resolveApiKeyForProviderMock) as { provider?: string };
    expect(apiKeyParams.provider).toBe("sample");
    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    const jsonRequest = requireFirstCallArg(postJsonRequestMock) as {
      url?: string;
      allowPrivateNetwork?: boolean;
      ssrfPolicy?: unknown;
      dispatcherPolicy?: unknown;
      body?: unknown;
    };
    expect(jsonRequest.url).toBe("https://sample.example/v1/images/generations");
    expect(jsonRequest.allowPrivateNetwork).toBe(true);
    expect(jsonRequest.ssrfPolicy).toEqual({ allowRfc2544BenchmarkRange: true });
    expect(jsonRequest.dispatcherPolicy).toEqual({ request: { allowPrivateNetwork: true } });
    expect(jsonRequest.body).toEqual({
      model: "custom-image",
      prompt: "draw a square",
      n: 2,
      size: "512x512",
      response_format: "b64_json",
    });
    const headers = requireFirstRequestHeaders(postJsonRequestMock);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(result.model).toBe("custom-image");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.fileName).toBe("image-1.png");
    expect(result.images[0]?.revisedPrompt).toBe("revised");
    expect(release).toHaveBeenCalledOnce();
  });

  it("downloads OpenAI-compatible URL image responses through guarded provider HTTP", async () => {
    const requestRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ url: "http://127.0.0.1:8080/generated.png" }],
        }),
      },
      release: requestRelease,
    });
    fetchWithTimeoutGuardedMock.mockResolvedValue({
      response: new Response(pngBytes, { headers: { "content-type": "image/png" } }),
      release: downloadRelease,
    });
    const provider = createProvider();

    const result = await provider.generateImage({
      provider: "sample",
      model: "sample-image",
      prompt: "draw a square",
      timeoutMs: 123,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: {
        models: {
          providers: {
            sample: {
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
    } as never);

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledOnce();
    const [url, init, timeoutMs, fetchFn, guardedOptions] = fetchWithTimeoutGuardedMock.mock
      .calls[0] as [string, RequestInit, number | undefined, typeof fetch, Record<string, unknown>];
    expect(url).toBe("http://127.0.0.1:8080/generated.png");
    expect(init).toEqual({ method: "GET" });
    expect(timeoutMs).toBe(123);
    expect(fetchFn).toBe(fetch);
    expect(createProviderOperationDeadlineMock).toHaveBeenCalledWith({
      timeoutMs: 123,
      label: "Sample image generation",
    });
    expect(resolveProviderOperationRemainingTimeoutMsMock).toHaveBeenCalledTimes(2);
    expect(guardedOptions).toEqual({
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      auditContext: "sample-image-download",
    });
    expect(result.images).toEqual([
      {
        buffer: pngBytes,
        mimeType: "image/png",
        fileName: "image-1.png",
      },
    ]);
    expect(requestRelease).toHaveBeenCalledOnce();
    expect(downloadRelease).toHaveBeenCalledOnce();
  });

  it("keeps provider transport policy for same-origin URL image responses", async () => {
    const requestRelease = vi.fn(async () => {});
    const downloadRelease = vi.fn(async () => {});
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ url: "http://127.0.0.1:8080/generated.png" }],
        }),
      },
      release: requestRelease,
    });
    fetchWithTimeoutGuardedMock.mockResolvedValue({
      response: new Response(pngBytes, { headers: { "content-type": "image/png" } }),
      release: downloadRelease,
    });
    const provider = createProvider();

    await provider.generateImage({
      provider: "sample",
      model: "sample-image",
      prompt: "draw a square",
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: {
        models: {
          providers: {
            sample: {
              baseUrl: "http://127.0.0.1:8080/v1",
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
    } as never);

    const downloadCall = fetchWithTimeoutGuardedMock.mock.calls[0] as [
      string,
      RequestInit,
      number | undefined,
      typeof fetch,
      Record<string, unknown>,
    ];
    expect(downloadCall[1].method).toBe("GET");
    expect(downloadCall[1].headers).toBeInstanceOf(Headers);
    expect(new Headers(downloadCall[1].headers).get("Authorization")).toBe("Bearer provider-key");
    expect(new Headers(downloadCall[1].headers).has("Content-Type")).toBe(false);
    const guardedOptions = downloadCall[4];
    expect(guardedOptions).toEqual({
      ssrfPolicy: { allowRfc2544BenchmarkRange: true, allowPrivateNetwork: true },
      dispatcherPolicy: { request: { allowPrivateNetwork: true } },
      auditContext: "sample-image-download",
    });
    expect(requestRelease).toHaveBeenCalledOnce();
    expect(downloadRelease).toHaveBeenCalledOnce();
  });

  it("posts multipart edit requests without forwarding a content-type header", async () => {
    mockGeneratedResponse();
    const provider = createProvider();

    await provider.generateImage({
      provider: "sample",
      model: "sample-image",
      prompt: "edit it",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
      cfg: {} as never,
    });

    const multipartRequest = requireFirstCallArg(postMultipartRequestMock) as {
      url?: string;
      body?: unknown;
    };
    expect(multipartRequest.url).toBe("https://sample.example/v1/images/edits");
    expect(multipartRequest.body).toBeInstanceOf(FormData);
    const headers = requireFirstRequestHeaders(postMultipartRequestMock);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("honors default operation timeouts and empty-response errors", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: { json: async () => ({ data: [] }) },
      release: vi.fn(async () => {}),
    });
    const provider = createProvider({
      defaultTimeoutMs: 60_000,
      emptyResponseError: "Sample response missing image data",
    });

    await expect(
      provider.generateImage({
        provider: "sample",
        model: "sample-image",
        prompt: "empty",
        timeoutMs: 123,
        cfg: {} as never,
      }),
    ).rejects.toThrow("Sample response missing image data");

    expect(createProviderOperationDeadlineMock).toHaveBeenCalledWith({
      timeoutMs: 123,
      label: "Sample image generation",
    });
    expect(resolveProviderOperationRemainingTimeoutMsMock).toHaveBeenCalledWith({
      deadline: { timeoutMs: 123, label: "Sample image generation" },
      defaultTimeoutMs: 60_000,
    });
    const timeoutRequest = requireFirstCallArg(postJsonRequestMock) as { timeoutMs?: number };
    expect(timeoutRequest.timeoutMs).toBe(123);
  });

  it("wraps malformed successful image responses with provider-owned errors", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: { json: async () => ({ data: { b64_json: "not-an-array" } }) },
      release: vi.fn(async () => {}),
    });
    const provider = createProvider();

    await expect(
      provider.generateImage({
        provider: "sample",
        model: "sample-image",
        prompt: "bad shape",
        cfg: {} as never,
      }),
    ).rejects.toThrow("Sample image generation response malformed");
  });
});
