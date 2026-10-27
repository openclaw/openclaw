import { afterEach, expect, it, vi } from "vitest";
import {
  createOpenAiCompatibleImageGenerationProvider,
  type OpenAiCompatibleImageProviderOptions,
} from "./openai-compatible-image-provider.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./types.js";

const { http, auth, availability } = vi.hoisted(() => ({
  http: {
    assertOkOrThrowHttpError: vi.fn(async () => {}),
    createProviderOperationDeadline: vi.fn((params: Record<string, unknown>) => ({
      timeoutMs: params.timeoutMs,
      label: params.label,
    })),
    postJsonRequest: vi.fn<typeof import("../plugin-sdk/provider-http.js").postJsonRequest>(),
    postMultipartRequest:
      vi.fn<typeof import("../plugin-sdk/provider-http.js").postMultipartRequest>(),
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
  },
  auth: { resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "provider-key" })) },
  availability: {
    isProviderApiKeyConfigured: vi.fn(() => true),
    isProviderApiKeyConfiguredAsync: vi.fn(async () => true),
  },
}));

// mock-isolation: Provider request tests supply auth readiness without host credential reads.
vi.mock("../plugins/provider-auth-availability.js", () => availability);

// mock-isolation: Resolve fixture credentials without reading host auth profiles.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => auth);

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return { ...actual, ...http };
});

function mockResponse(data: unknown, mode: "json" | "multipart" = "json") {
  const response = {
    response: Response.json({ data }),
    finalUrl: "https://sample.example/v1/images/generations",
    release: vi.fn(async () => {}),
  };
  (mode === "json" ? http.postJsonRequest : http.postMultipartRequest).mockResolvedValue(response);
  return response.release;
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

function configuredProviders(
  providers: NonNullable<ImageGenerationRequest["cfg"]["models"]>["providers"],
) {
  return { models: { providers } };
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
    buildEditRequest: () => ({ kind: "multipart", form: new FormData() }),
    ...overrides,
  });
}

afterEach(() => {
  for (const mock of [
    ...Object.values(http),
    ...Object.values(auth),
    ...Object.values(availability),
  ]) {
    mock.mockClear();
  }
  http.postJsonRequest.mockReset();
  http.postMultipartRequest.mockReset();
});

it("checks config-backed auth under the credential owner, not its HTTP config alias", async () => {
  const provider = createProvider({ providerConfigKey: "different-http-provider" });
  const cfg = configuredProviders({
    sample: providerConfig({ apiKey: "sample-config-key" }),
    "different-http-provider": providerConfig({
      apiKey: "wrong-owner-key",
      baseUrl: "https://different-http-provider.example/v1/",
    }),
  });

  expect(provider.isConfigured?.({ cfg, agentDir: "/tmp/agent" })).toBe(true);
  const authContext = { provider: "sample", cfg, agentDir: "/tmp/agent" };
  expect(availability.isProviderApiKeyConfigured).toHaveBeenCalledWith(authContext);
  expect(await provider.isConfiguredAsync?.({ cfg, agentDir: "/tmp/agent" })).toBe(true);
  expect(availability.isProviderApiKeyConfiguredAsync).toHaveBeenCalledWith(authContext);
});

it("posts JSON generation requests and parses OpenAI-compatible image data", async () => {
  const imageBytes = Buffer.alloc(7 * 1024 * 1024, 1);
  const release = mockResponse([
    { b64_json: imageBytes.toString("base64"), revised_prompt: "revised" },
  ]);
  const result = await generate(createProvider(), {
    model: "custom-image",
    count: 2,
    size: "512x512",
    ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    cfg: {
      ...configuredProviders({
        sample: providerConfig({ request: { allowPrivateNetwork: true } }),
      }),
      agents: { defaults: { mediaMaxMb: 8 } },
    },
  });

  expect(auth.resolveApiKeyForProvider).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "sample" }),
  );
  expect(http.sanitizeConfiguredModelProviderRequest).toHaveBeenCalledWith({
    allowPrivateNetwork: true,
  });
  const jsonRequest = http.postJsonRequest.mock.calls[0]![0];
  expect(jsonRequest).toMatchObject({
    url: "https://sample.example/v1/images/generations",
    allowPrivateNetwork: true,
    ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    dispatcherPolicy: { request: { allowPrivateNetwork: true } },
  });
  expect(jsonRequest.body).toEqual({
    model: "custom-image",
    prompt: "draw a square",
    n: 2,
    size: "512x512",
    response_format: "b64_json",
  });
  expect(new Headers(jsonRequest.headers).get("Content-Type")).toBe("application/json");
  expect(result).toEqual({
    model: "custom-image",
    images: [
      {
        buffer: imageBytes,
        mimeType: "image/png",
        fileName: "image-1.png",
        revisedPrompt: "revised",
      },
    ],
  });
  expect(release).toHaveBeenCalledOnce();
});

it("rejects image JSON beyond the generated image download ceiling", async () => {
  mockResponse([{ b64_json: "x".repeat(90 * 1024 * 1024) }], "multipart");
  await expect(
    generate(createProvider(), {
      prompt: "too large",
      inputImages: [{ buffer: Buffer.from("source"), mimeType: "image/png" }],
    }),
  ).rejects.toThrow("sample.image-generation: JSON response exceeds");
  const request = http.postMultipartRequest.mock.calls[0]![0];
  expect(request.url).toBe("https://sample.example/v1/images/edits");
  expect(request.body).toBeInstanceOf(FormData);
  expect(new Headers(request.headers).has("Content-Type")).toBe(false);
});

it.each([
  [[], "Sample response missing image data"],
  [{ b64_json: "not-an-array" }, "Sample image generation response malformed"],
] as const)("honors operation timeouts and reports invalid response %j", async (data, error) => {
  mockResponse(data);
  const provider = createProvider({
    defaultTimeoutMs: 60_000,
    emptyResponseError: "Sample response missing image data",
  });

  await expect(generate(provider, { timeoutMs: 123 })).rejects.toThrow(error);

  expect(http.createProviderOperationDeadline).toHaveBeenCalledWith({
    timeoutMs: 123,
    label: "Sample image generation",
  });
  expect(http.resolveProviderOperationTimeoutMs).toHaveBeenCalledWith({
    deadline: { timeoutMs: 123, label: "Sample image generation" },
    defaultTimeoutMs: 60_000,
  });
  expect(http.postJsonRequest.mock.calls[0]![0].timeoutMs).toBe(60_000);
});
