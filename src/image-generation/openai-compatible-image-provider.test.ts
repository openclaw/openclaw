import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleImageGenerationProvider,
  type OpenAiCompatibleImageProviderOptions,
} from "./openai-compatible-image-provider.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./types.js";

const mocks = vi.hoisted(() => ({
  assertOkOrThrowHttpError: vi.fn(async () => {}),
  createProviderOperationDeadline: vi.fn((params: Record<string, unknown>) => ({
    timeoutMs: params.timeoutMs,
    label: params.label,
  })),
  isProviderApiKeyConfigured: vi.fn(() => true),
  isProviderApiKeyConfiguredAsync: vi.fn(async () => true),
  postJsonRequest: vi.fn<typeof import("../plugin-sdk/provider-http.js").postJsonRequest>(),
  postMultipartRequest:
    vi.fn<typeof import("../plugin-sdk/provider-http.js").postMultipartRequest>(),
  resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "provider-key" })),
  resolveProviderHttpRequestConfig: vi.fn((params: Record<string, unknown>) => {
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
  resolveProviderOperationTimeoutMs: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs,
  ),
  sanitizeConfiguredModelProviderRequest: vi.fn((request) => request),
}));

// mock-isolation: Provider request tests supply auth readiness without host credential reads.
vi.mock("../plugins/provider-auth-availability.js", () => ({
  isProviderApiKeyConfigured: mocks.isProviderApiKeyConfigured,
  isProviderApiKeyConfiguredAsync: mocks.isProviderApiKeyConfiguredAsync,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    assertOkOrThrowHttpError: mocks.assertOkOrThrowHttpError,
    createProviderOperationDeadline: mocks.createProviderOperationDeadline,
    postJsonRequest: mocks.postJsonRequest,
    postMultipartRequest: mocks.postMultipartRequest,
    readProviderJsonResponse: actual.readProviderJsonResponse,
    resolveProviderHttpRequestConfig: mocks.resolveProviderHttpRequestConfig,
    resolveProviderOperationTimeoutMs: mocks.resolveProviderOperationTimeoutMs,
    sanitizeConfiguredModelProviderRequest: mocks.sanitizeConfiguredModelProviderRequest,
  };
});

function jsonResponse(payload: unknown) {
  return {
    response: Response.json(payload),
    finalUrl: "https://sample.example/v1/images/generations",
    release: vi.fn(async () => {}),
  };
}

function generate(provider: ImageGenerationProvider, overrides: Partial<ImageGenerationRequest>) {
  return provider.generateImage({
    provider: "sample",
    model: "sample-image",
    prompt: "draw a square",
    cfg: {},
    ...overrides,
  });
}

function providerConfig<T extends object>(overrides: T) {
  return { baseUrl: "https://sample.example/v1/", models: [], ...overrides };
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
  const payload = {
    data: [{ b64_json: Buffer.from("image-bytes").toString("base64"), revised_prompt: "revised" }],
  };
  const response = jsonResponse(payload);
  mocks.postJsonRequest.mockResolvedValue(response);
  mocks.postMultipartRequest.mockResolvedValue({
    ...jsonResponse(payload),
    release: response.release,
  });
  return response.release;
}

describe("OpenAI-compatible image provider helper", () => {
  afterEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }
    mocks.postJsonRequest.mockReset();
    mocks.postMultipartRequest.mockReset();
    mocks.resolveApiKeyForProvider.mockReset().mockResolvedValue({ apiKey: "provider-key" });
  });

  it("checks config-backed auth under the credential owner, not its HTTP config alias", async () => {
    const provider = createProvider({ providerConfigKey: "different-http-provider" });
    const cfg = {
      models: {
        providers: {
          sample: providerConfig({ apiKey: "sample-config-key" }),
          "different-http-provider": providerConfig({
            apiKey: "wrong-owner-key",
            baseUrl: "https://different-http-provider.example/v1/",
          }),
        },
      },
    };

    expect(provider.isConfigured?.({ cfg, agentDir: "/tmp/agent" })).toBe(true);
    const authContext = { provider: "sample", cfg, agentDir: "/tmp/agent" };
    expect(mocks.isProviderApiKeyConfigured).toHaveBeenCalledWith(authContext);
    expect(await provider.isConfiguredAsync?.({ cfg, agentDir: "/tmp/agent" })).toBe(true);
    expect(mocks.isProviderApiKeyConfiguredAsync).toHaveBeenCalledWith(authContext);
  });

  it("posts JSON generation requests and parses OpenAI-compatible image data", async () => {
    const release = mockGeneratedResponse();
    const result = await generate(createProvider(), {
      model: "custom-image",
      prompt: "draw a square",
      count: 2,
      size: "512x512",
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: {
        models: {
          providers: {
            sample: providerConfig({ request: { allowPrivateNetwork: true } }),
          },
        },
      },
    });

    expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "sample" }),
    );
    expect(mocks.sanitizeConfiguredModelProviderRequest).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    const jsonRequest = mocks.postJsonRequest.mock.calls[0]![0];
    expect(jsonRequest).toMatchObject({
      url: "https://sample.example/v1/images/generations",
      allowPrivateNetwork: true,
    });
    expect({ ssrf: jsonRequest.ssrfPolicy, dispatcher: jsonRequest.dispatcherPolicy }).toEqual({
      ssrf: { allowRfc2544BenchmarkRange: true },
      dispatcher: { request: { allowPrivateNetwork: true } },
    });
    expect(jsonRequest.body).toEqual({
      model: "custom-image",
      prompt: "draw a square",
      n: 2,
      size: "512x512",
      response_format: "b64_json",
    });
    expect(jsonRequest.headers).toBeInstanceOf(Headers);
    const headers = new Headers(jsonRequest.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(result.model).toBe("custom-image");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      mimeType: "image/png",
      fileName: "image-1.png",
      revisedPrompt: "revised",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("honors configured generated media caps above the default image limit", async () => {
    const imageBytes = Buffer.alloc(7 * 1024 * 1024, 1);
    mocks.postJsonRequest.mockResolvedValue(
      jsonResponse({ data: [{ b64_json: imageBytes.toString("base64") }] }),
    );
    const result = await generate(createProvider(), {
      prompt: "large",
      cfg: { agents: { defaults: { mediaMaxMb: 8 } } },
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.buffer.byteLength).toBe(imageBytes.byteLength);
  });

  it("rejects image JSON beyond the generated image download ceiling", async () => {
    // Edit mode returns at most one image, so the bound is one 64 MiB image as base64.
    mocks.postMultipartRequest.mockResolvedValue(
      jsonResponse({ data: [{ b64_json: "x".repeat(90 * 1024 * 1024) }] }),
    );
    await expect(
      generate(createProvider(), {
        prompt: "too large",
        inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("sample.image-generation: JSON response exceeds");
  });

  it("posts multipart edit requests without forwarding a content-type header", async () => {
    mockGeneratedResponse();
    await generate(createProvider(), {
      prompt: "edit it",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
    });

    const multipartRequest = mocks.postMultipartRequest.mock.calls[0]![0];
    expect(multipartRequest.url).toBe("https://sample.example/v1/images/edits");
    expect(multipartRequest.body).toBeInstanceOf(FormData);
    expect(multipartRequest.headers).toBeInstanceOf(Headers);
    const headers = new Headers(multipartRequest.headers);
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("honors default operation timeouts and empty-response errors", async () => {
    mocks.postJsonRequest.mockResolvedValue(jsonResponse({ data: [] }));
    const provider = createProvider({
      defaultTimeoutMs: 60_000,
      emptyResponseError: "Sample response missing image data",
    });

    await expect(
      generate(provider, {
        prompt: "empty",
        timeoutMs: 123,
      }),
    ).rejects.toThrow("Sample response missing image data");

    expect(mocks.createProviderOperationDeadline).toHaveBeenCalledWith({
      timeoutMs: 123,
      label: "Sample image generation",
    });
    expect(mocks.resolveProviderOperationTimeoutMs).toHaveBeenCalledWith({
      deadline: { timeoutMs: 123, label: "Sample image generation" },
      defaultTimeoutMs: 60_000,
    });
    const timeoutRequest = mocks.postJsonRequest.mock.calls[0]![0];
    expect(timeoutRequest.timeoutMs).toBe(60_000);
  });

  it("wraps malformed successful image responses with provider-owned errors", async () => {
    mocks.postJsonRequest.mockResolvedValue(jsonResponse({ data: { b64_json: "not-an-array" } }));
    await expect(generate(createProvider(), { prompt: "bad shape" })).rejects.toThrow(
      "Sample image generation response malformed",
    );
  });
});
