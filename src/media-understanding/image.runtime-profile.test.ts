// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
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
} = imageRuntimeMocks;

const resolveProviderRuntimePluginHandleMock = vi.hoisted(() => vi.fn());
vi.mock("../plugins/provider-hook-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-hook-runtime.js")>(
    "../plugins/provider-hook-runtime.js",
  )),
  resolveProviderRuntimePluginHandle: resolveProviderRuntimePluginHandleMock,
}));
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

  it.each([undefined])(
    "derives workspaceDir from agentId when workspaceDir is %j",
    async (workspaceDir) => {
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
          entries: {
            "vision-agent": {
              agentDir: "/tmp/openclaw-agent",
              workspace: "/tmp/openclaw-workspace",
            },
          },
        },
      };

      await describeImageWithModelCore({
        ...imageRequestDefaults(),
        cfg,
        agentId: "vision-agent",
        workspaceDir,
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
    },
  );

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
