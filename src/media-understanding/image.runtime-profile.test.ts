import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Context, Model, ProviderStreamOptions } from "../llm/types.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../secrets/sentinel.js";
import {
  API_KEY_FIELD,
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
const { describeImageWithModelCore } = await import("./image.js");
type ImageRequest = Parameters<typeof describeImageWithModelCore>[0];
function describeImage(provider: string, model: string, overrides: Partial<ImageRequest> = {}) {
  return describeImageWithModelCore({ ...imageRequestDefaults(), provider, model, ...overrides });
}
function mockGoogleCompletion(text: string) {
  mockImageModel({ provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai" });
  completeMock.mockResolvedValue(
    imageCompletion("google-generative-ai", "google", "gemini-2.5-flash", text),
  );
}

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

  it("normalizes deprecated google flash ids and keeps profile model/auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect([provider, modelId]).toEqual(["google", "gemini-3-flash-preview"]);
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

    const result = await describeImage("google", "gemini-3.1-flash-preview", {
      profile: "google:default",
      preferredProfile: "google:preferred",
    });

    expect(result).toEqual({ text: "flash ok", model: "gemini-3-flash-preview" });
    expect(findMock).toHaveBeenCalled();
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4]).toMatchObject({
        authProfileId: "google:default",
        preferredProfile: "google:preferred",
      });
    }
    expect(getApiKeyForModelMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        profileId: "google:default",
        preferredProfile: "google:preferred",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "test-token");
  });

  it("rematerializes profile-scoped image metadata after auth selects a backup profile", async () => {
    const authStorage = preparedAuthStorage;
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
      imageCompletion("openai-responses", "github-copilot", "gpt-5.6-sol", "ok"),
    );

    await describeImage("github-copilot", "gpt-5.6-sol", { profile: "github-copilot:preferred" });

    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(2);
    expect(resolveModelAsyncMock.mock.calls[1]?.[4]).toMatchObject({
      authStorage,
      modelRegistry,
      authProfileId: "github-copilot:backup",
    });
    const [model, , options] = expectDefined(completeMock.mock.calls[0], "completion");
    const requestSignal = acquireAgentRunPreparedModelRuntimeMock.mock.calls[0]?.[1].abortSignal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    for (const call of resolveModelAsyncMock.mock.calls) {
      expect(call[4].abortSignal).toBe(requestSignal);
    }
    expect(options.signal).toBe(requestSignal);
    expect(model).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000 });
  });

  it("places image prompt in user content for github-copilot provider", async () => {
    const ref = { provider: "github-copilot", model: "gemini-3.1-pro-preview" };
    const response = imageCompletion("openai-completions", ref.provider, ref.model, "ok");
    const stream = vi.fn((_m: Model, _ctx: Context, _opts: ProviderStreamOptions) => ({
      result: vi.fn(async () => response),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(stream);
    mockImageModel({
      provider: ref.provider,
      id: ref.model,
      api: "openai-completions",
      baseUrl: "https://stale.example.test",
    });

    await describeImage(ref.provider, ref.model);

    expect(completeMock).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledOnce();
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
    const [model, context, options] = expectDefined(stream.mock.calls[0], "stream");
    expect(model).toMatchObject({
      baseUrl: "https://api.githubcopilot.com",
      headers: {
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Editor-Version": "vscode/1.107.0",
        "Openai-Organization": "github-copilot",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
    });
    expect(Object.values(model.headers ?? {}).some((value) => looksLikeSecretSentinel(value))).toBe(
      false,
    );
    expect(options).toMatchObject({
      apiKey: storedValue,
      headers: { "Copilot-Vision-Request": "true", "x-initiator": "user" },
    });
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages?.find((m) => m.role === "user");
    const contentTypes = Array.isArray(userMessage?.content)
      ? userMessage.content.map((block) => block.type)
      : [];
    expect(contentTypes).toEqual(expect.arrayContaining(["text", "image"]));
  });

  it.each([false, true])(
    "uses the correct workspace/runtime owner (parent supplied: %s)",
    async (supplied) => {
      const agentDir = supplied ? "/tmp/parent-agent" : "/tmp/openclaw-agent";
      const workspaceDir = supplied ? "/tmp/parent-workspace" : "/tmp/openclaw-workspace";
      const cfg: OpenClawConfig = supplied
        ? { logging: { level: "info" } }
        : {
            agents: { entries: { "vision-agent": { agentDir, workspace: workspaceDir } } },
          };
      const text = supplied ? "parent runtime" : "workspace ok";
      mockGoogleCompletion(text);
      const preparedModelRuntime = supplied
        ? {
            agentDir,
            workspaceDir,
            config: cfg,
            metadataSnapshot: createEmptyPluginMetadataSnapshot(workspaceDir),
            createStores: () => ({ authStorage: preparedAuthStorage, modelRegistry: {} }),
          }
        : undefined;
      const result = await describeImage("google", "gemini-2.5-flash", {
        cfg: supplied ? { logging: { level: "debug" } } : cfg,
        buffer: Buffer.alloc(1),
        ...(supplied
          ? {
              agentDir: "/tmp/request-agent",
              workspaceDir: "/tmp/request-workspace",
              preparedModelRuntime,
            }
          : { agentId: "vision-agent" }),
      });
      expect(registerProviderStreamForModelMock).toHaveBeenCalledWith(
        expect.objectContaining({ cfg, agentDir, workspaceDir, wrapProviderStream: true }),
      );
      if (supplied) {
        expect(result.text).toBe(text);
        expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
        expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();
        for (const call of resolveModelAsyncMock.mock.calls) {
          expect(call[4]).toMatchObject({ preparedModelRuntime });
        }
      } else {
        expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceDir, loadRuntimePlugins: true }),
          expect.objectContaining({ catalogMode: "static", abortSignal: expect.any(AbortSignal) }),
        );
        expect(resolveModelAsyncMock).toHaveBeenCalledWith(
          "google",
          "gemini-2.5-flash",
          agentDir,
          cfg,
          expect.objectContaining({ workspaceDir }),
        );
      }
    },
  );
});
