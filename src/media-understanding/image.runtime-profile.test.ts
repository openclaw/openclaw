// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginMetadataSnapshot } from "../agents/test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import {
  API_KEY_FIELD,
  SET_RUNTIME_API_KEY_FIELD,
  imageRuntimeMocks,
  imageRequestDefaults,
  mockImageModel,
  imageCompletion,
  installImageRuntimeTestHooks,
  preparedAuthStorage,
} from "./image.test-support.js";

const {
  completeMock,
  getApiKeyForModelMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  registerProviderStreamForModelMock,
  prepareProviderRuntimeAuthMock,
  acquireAgentRunPreparedModelRuntimeMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  shouldPreferProviderRuntimeResolvedModelMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = imageRuntimeMocks;

const resolveProviderRuntimePluginHandleMock = vi.hoisted(() => vi.fn());
vi.mock("../plugins/provider-hook-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-hook-runtime.js")>(
    "../plugins/provider-hook-runtime.js",
  )),
  resolveProviderRuntimePluginHandle: resolveProviderRuntimePluginHandleMock,
}));
const MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL = Symbol.for(
  "openclaw.modelProviderRuntimePluginHandle",
);
type AuthRequestCall = {
  profileId?: string;
  preferredProfile?: string;
  store?: unknown;
};

const { describeImageWithModelCore } = await import("./image.js");

describe("describeImageWithModelCore", () => {
  installImageRuntimeTestHooks({
    copilotHeaders: {
      "Editor-Version": "vscode/1.107.0",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
  });
  beforeEach(() => {
    resolveProviderRuntimePluginHandleMock.mockReset().mockImplementation((params) => ({
      ...params,
      plugin: undefined,
    }));
  });

  function getApiKeyForModelCall(index = 0): AuthRequestCall {
    const call = (getApiKeyForModelMock.mock.calls as unknown[][]).at(index);
    if (!call) {
      throw new Error(`Expected getApiKeyForModelCore call ${index}`);
    }
    return call[0] as AuthRequestCall;
  }

  it("normalizes deprecated google flash ids and keeps profile model/auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3-flash-preview");
      return {
        provider: "google",
        id: "gemini-3-flash-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue(
      imageCompletion("google-generative-ai", "google", "gemini-3-flash-preview", "flash ok"),
    );

    const result = await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "google",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      preferredProfile: "google:preferred",
      prompt: "Describe the image.",
    });

    expect(result).toEqual({
      text: "flash ok",
      model: "gemini-3-flash-preview",
    });
    expect(findMock).toHaveBeenCalled();
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4]).toEqual(
        expect.objectContaining({
          authProfileId: "google:default",
          preferredProfile: "google:preferred",
        }),
      );
    }
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(authRequest?.preferredProfile).toBe("google:preferred");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "test-token");
  });

  it("keeps stable GA gemini 3.1 flash-lite ids during lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3.1-flash-lite");
      return {
        provider: "google",
        id: "gemini-3.1-flash-lite",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue(
      imageCompletion("google-generative-ai", "google", "gemini-3.1-flash-lite", "flash lite ok"),
    );

    const result = await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "google",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      prompt: "Describe the image.",
    });

    expect(result).toEqual({
      text: "flash lite ok",
      model: "gemini-3.1-flash-lite",
    });
    expect(findMock).toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "test-token");
  });

  it("rematerializes profile-scoped image metadata after auth selects a backup profile", async () => {
    const authStorage = { [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock };
    const modelRegistry = {};
    const hintedModel = {
      provider: "github-copilot",
      id: "gpt-5.6-sol",
      api: "openai-responses",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
    const authoritativeModel = {
      ...hintedModel,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    };
    resolveModelAsyncMock
      .mockResolvedValueOnce({ model: hintedModel, authStorage, modelRegistry })
      .mockResolvedValueOnce({ model: authoritativeModel, authStorage, modelRegistry });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: "test-token",
      source: "profile:github-copilot:backup",
      mode: "token",
      profileId: "github-copilot:backup",
    });
    shouldPreferProviderRuntimeResolvedModelMock.mockReturnValueOnce(true);
    completeMock.mockResolvedValue(
      imageCompletion(
        "openai-responses",
        "github-copilot",
        "gpt-5.6-sol",
        "profile-scoped image ok",
      ),
    );

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      profile: "github-copilot:preferred",
      prompt: "Describe the image.",
    });

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(2);
    expect(resolveModelAsyncMock.mock.calls[1]?.[4]).toEqual(
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "github-copilot:backup",
      }),
    );
    const [completionModel, , completionOptions] = expectDefined(
      completeMock.mock.calls[0],
      "complete call 0",
    );
    const requestSignal = acquireAgentRunPreparedModelRuntimeMock.mock.calls[0]?.[1].abortSignal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(resolveModelAsyncMock.mock.calls[0]?.[4].abortSignal).toBe(requestSignal);
    expect(resolveModelAsyncMock.mock.calls[1]?.[4].abortSignal).toBe(requestSignal);
    expect(completionOptions.signal).toBe(requestSignal);
    expect(completionModel).toEqual(
      expect.objectContaining({
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }),
    );
  });

  it("places image prompt in user content for github-copilot provider", async () => {
    const providerStreamResult = imageCompletion(
      "openai-completions",
      "github-copilot",
      "gemini-3.1-pro-preview",
      "A solid red square.",
    );
    const providerStreamFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: vi.fn(async () => providerStreamResult),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    mockImageModel({
      provider: "github-copilot",
      id: "gemini-3.1-pro-preview",
      api: "openai-completions",
      baseUrl: "https://stale.example.test",
    });

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      prompt: "Describe the image.",
    });

    expect(completeMock).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledOnce();
    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({ [API_KEY_FIELD]: "test-token", authMode: "oauth" }),
      }),
    );
    const storedValue = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(setRuntimeApiKeyMock.mock.calls[0]?.[0]).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedValue)).toBe(true);
    expect(storedValue).not.toBe("test-token");
    expect(resolveSecretSentinel(storedValue)).toBe("test-token");
    const [completionModel, context, options] = providerStreamFn.mock.calls[0] as unknown as [
      { baseUrl?: string; headers?: Record<string, string> },
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
      { apiKey?: string; headers?: Record<string, string> },
    ];
    expect(completionModel.baseUrl).toBe("https://api.githubcopilot.com");
    expect(completionModel.headers).toMatchObject({
      "Copilot-Integration-Id": "copilot-developer-cli",
      "Editor-Version": "vscode/1.107.0",
      "Openai-Organization": "github-copilot",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    });
    expect(
      Object.values(completionModel.headers ?? {}).some((value) => looksLikeSecretSentinel(value)),
    ).toBe(false);
    expect(options.apiKey).toBe(storedValue);
    expect(options.headers).toMatchObject({
      "Copilot-Vision-Request": "true",
      "x-initiator": "user",
    });
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).toContain("text");
    expect(contentTypes).toContain("image");
  });

  it("keeps an exchanged Copilot image token opaque for sentinel-backed auth", async () => {
    const sourceValue = "test-token";
    const preparedValue = mintSecretSentinel(sourceValue, {
      label: "model-auth:github-copilot",
    });
    getApiKeyForModelMock.mockResolvedValueOnce({
      [API_KEY_FIELD]: preparedValue,
      source: "test",
      mode: "token",
    });
    unwrapSecretSentinelsForProviderEgressMock.mockReturnValueOnce(sourceValue);
    const providerStreamFn = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: vi.fn(async () =>
        imageCompletion("openai-completions", "github-copilot", "gpt-4.1", "ok"),
      ),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    mockImageModel({
      provider: "github-copilot",
      id: "gpt-4.1",
      api: "openai-completions",
    });

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "github-copilot",
      model: "gpt-4.1",
    });

    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({ [API_KEY_FIELD]: preparedValue, authMode: "token" }),
      }),
    );
    const storedValue = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(looksLikeSecretSentinel(storedValue)).toBe(true);
    expect(resolveSecretSentinel(storedValue)).toBe("test-token");
    const streamOptions = providerStreamFn.mock.calls[0]?.[2] as { apiKey?: string };
    expect(streamOptions.apiKey).toBe(storedValue);
  });

  it("fails github-copilot image runtime setup when token exchange fails", async () => {
    mockImageModel({
      provider: "github-copilot",
      id: "gemini-3.1-pro-preview",
      api: "openai-completions",
      baseUrl: "https://api.githubcopilot.com",
    });
    prepareProviderRuntimeAuthMock.mockRejectedValueOnce(
      new Error("Copilot token exchange failed: HTTP 401"),
    );

    await expect(
      describeImageWithModelCore({
        ...imageRequestDefaults(),
        provider: "github-copilot",
        model: "gemini-3.1-pro-preview",
        prompt: "Describe the image.",
      }),
    ).rejects.toThrow("Copilot token exchange failed: HTTP 401");

    expect(setRuntimeApiKeyMock).not.toHaveBeenCalledWith("github-copilot", "test-token");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("caps image-describe maxTokens by the resolved model's own maxTokens", async () => {
    mockImageModel({
      api: "openai-completions",
      provider: "fake",
      id: "small-vlm",
      baseUrl: "https://example.test",
      maxTokens: 1024,
    });
    completeMock.mockResolvedValue(
      imageCompletion("openai-completions", "fake", "small-vlm", "ok"),
    );

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      provider: "fake",
      model: "small-vlm",
      prompt: "Describe the image.",
    });

    const options = expectDefined(completeMock.mock.calls[0], "image completion call 0")[2];
    expect(options.maxTokens).toBe(1024);
  });

  it("derives workspaceDir from agentId for image runtime resolution", async () => {
    mockImageModel({
      provider: "google",
      id: "gemini-2.5-flash",
      api: "google-generative-ai",
    });
    completeMock.mockResolvedValue(
      imageCompletion("google-generative-ai", "google", "gemini-2.5-flash", "workspace ok"),
    );
    const cfg = {
      agents: {
        list: [
          {
            id: "vision-agent",
            agentDir: "/tmp/openclaw-agent",
            workspace: "/tmp/openclaw-workspace",
          },
        ],
      },
    };

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      cfg,
      agentId: "vision-agent",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.alloc(1),
      prompt: "Describe the image.",
    });

    expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/openclaw-workspace",
        loadRuntimePlugins: true,
      }),
      expect.objectContaining({ catalogMode: "static", abortSignal: expect.any(AbortSignal) }),
    );
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/openclaw-agent",
      cfg,
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-workspace" }),
    );
  });

  it("uses one committed prepared generation for image setup and streaming", async () => {
    const requestedCfg: OpenClawConfig = { logging: { level: "info" } };
    const committedCfg: OpenClawConfig = { logging: { level: "debug" } };
    const metadataSnapshot = createEmptyPluginMetadataSnapshot("/tmp/committed-workspace");
    const providerRuntimeHandle = {
      provider: "google",
      modelId: "gemini-2.5-flash",
      plugin: { id: "generation-a" },
    };
    resolveProviderRuntimePluginHandleMock.mockReturnValueOnce(providerRuntimeHandle);
    acquireAgentRunPreparedModelRuntimeMock.mockResolvedValueOnce({
      snapshot: {
        agentDir: "/tmp/committed-agent",
        config: committedCfg,
        workspaceDir: "/tmp/committed-workspace",
        metadataSnapshot,
        createStores: () => ({
          authStorage: preparedAuthStorage,
          modelRegistry: {},
        }),
      },
      [Symbol.asyncDispose]: releasePreparedModelRuntimeMock,
    });
    mockImageModel({
      provider: "google",
      id: "gemini-2.5-flash",
      api: "google-generative-ai",
    });
    registerProviderStreamForModelMock.mockImplementationOnce(({ model }) => {
      expect((model as Record<symbol, unknown>)[MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]).toBe(
        providerRuntimeHandle,
      );
      return undefined;
    });
    completeMock.mockResolvedValue(
      imageCompletion("google-generative-ai", "google", "gemini-2.5-flash", "committed runtime"),
    );

    await describeImageWithModelCore({
      ...imageRequestDefaults(),
      cfg: requestedCfg,
      agentDir: "/tmp/requested-agent",
      workspaceDir: "/tmp/requested-workspace",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.alloc(1),
      prompt: "Describe the image.",
    });

    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/committed-agent",
      committedCfg,
      expect.objectContaining({ workspaceDir: "/tmp/committed-workspace" }),
    );
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: expect.objectContaining({ id: "gemini-2.5-flash" }),
      cfg: committedCfg,
      agentDir: "/tmp/committed-agent",
      workspaceDir: "/tmp/committed-workspace",
      wrapProviderStream: true,
    });
    expect(resolveProviderRuntimePluginHandleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        modelId: "gemini-2.5-flash",
        pluginMetadataSnapshot: metadataSnapshot,
      }),
    );
  });

  it("reuses a parent run generation without acquiring another image lease", async () => {
    const cfg: OpenClawConfig = { logging: { level: "info" } };
    mockImageModel({
      provider: "google",
      id: "gemini-2.5-flash",
      api: "google-generative-ai",
    });
    completeMock.mockResolvedValue(
      imageCompletion("google-generative-ai", "google", "gemini-2.5-flash", "parent runtime"),
    );
    const preparedModelRuntime = {
      agentDir: "/tmp/parent-agent",
      config: cfg,
      workspaceDir: "/tmp/parent-workspace",
      metadataSnapshot: createEmptyPluginMetadataSnapshot("/tmp/parent-workspace"),
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => ({ authStorage: preparedAuthStorage, modelRegistry: {} }),
    } as never;

    const result = await describeImageWithModelCore({
      ...imageRequestDefaults(),
      cfg,
      agentDir: "/tmp/parent-agent",
      workspaceDir: "/tmp/parent-workspace",
      preparedModelRuntime,
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.alloc(1),
      prompt: "Describe the image.",
    });

    expect(result.text).toBe("parent runtime");
    expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
    expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4]).toEqual(expect.objectContaining({ preparedModelRuntime }));
    }
  });
});
