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

describe("describeImageWithModelCore", () => {
  installImageRuntimeTestHooks();
  beforeEach(() => {
    resolveProviderRuntimePluginHandleMock.mockReset().mockImplementation((params) => ({
      ...params,
      plugin: undefined,
    }));
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

    const profile = "github-copilot:preferred";
    const preferredProfile = "github-copilot:preferred-order";
    await describeImage("github-copilot", "gpt-5.6-sol", { profile, preferredProfile });
    expect(resolveModelAsyncMock.mock.calls[0]?.[4]).toMatchObject({
      authProfileId: profile,
      preferredProfile,
    });
    expect(getApiKeyForModelMock.mock.calls[0]?.[0]).toMatchObject({
      profileId: profile,
      preferredProfile,
    });

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

    const authCall = expectDefined(prepareProviderRuntimeAuthMock.mock.calls[0], "runtime auth")[0];
    expect(authCall).toMatchObject({
      provider: "github-copilot",
      context: { [API_KEY_FIELD]: "test-token", authMode: "oauth" },
    });
    const storedValue = setRuntimeApiKeyMock.mock.calls[0]?.[1] as string;
    expect(setRuntimeApiKeyMock.mock.calls[0]?.[0]).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedValue)).toBe(true);
    expect(storedValue).not.toBe("test-token");
    expect(resolveSecretSentinel(storedValue)).toBe("test-token");
    const [model, context, options] = expectDefined(stream.mock.calls[0], "stream");
    expect(model.baseUrl).toBe("https://api.githubcopilot.com");
    expect(
      Object.values(model.headers ?? {}).some(
        (value) => value !== null && looksLikeSecretSentinel(value),
      ),
    ).toBe(false);
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

  it("rejects a resolved text-only model before authenticating or dispatching it", async () => {
    mockImageModel({ provider: "google", id: "text-only", input: ["text"] });
    await expect(describeImage("google", "text-only")).rejects.toThrow(
      "Model does not support images: google/text-only",
    );
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses the correct workspace/runtime owner (parent supplied: %s)",
    async (supplied) => {
      const agentDir = supplied ? "/tmp/parent-agent" : "/tmp/openclaw-agent";
      const workspaceDir = supplied ? "/tmp/parent-workspace" : "/tmp/openclaw-workspace";
      const cfg: OpenClawConfig = {
        agents: { entries: { "vision-agent": { agentDir, workspace: workspaceDir } } },
      };
      const text = supplied ? "parent runtime" : "workspace ok";
      mockImageModel({ provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai" });
      completeMock.mockResolvedValue(
        imageCompletion("google-generative-ai", "google", "gemini-2.5-flash", text),
      );
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
      expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "test-token");
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
