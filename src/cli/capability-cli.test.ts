// Capability CLI tests cover capability command registration and output formatting.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { inspectLocalAudioSelection } from "../media-understanding/local-audio.js";
import { registerCapabilityCli } from "./capability-cli.js";
import {
  runCap,
  runCapability,
  runCapabilityWithParentAgent,
  runModelAuthWithAgent,
} from "./capability-cli.test-harness.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yf7kAAAAASUVORK5CYII=";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function primeOpenAiAuthProfile(mode: "api-key" | "token" = "api-key"): void {
  mocks.resolveApiKeyForProviderCore.mockResolvedValueOnce({
    apiKey: mode === "token" ? "profile-openai-token" : "profile-openai-key",
    source: mode === "token" ? "profile:openai:token" : "profile:openai:qa",
    mode,
  });
}

function preparedModel(provider = "openai", modelId = "gpt-5.4", chatGpt = false) {
  return {
    async [Symbol.asyncDispose]() {
      mocks.releaseSimpleCompletion();
    },
    selection: { provider, modelId, agentDir: "/tmp/agent" },
    model: {
      provider,
      id: modelId,
      maxTokens: 128,
      ...(chatGpt ? { api: "openai-chatgpt-responses" } : {}),
    },
    auth: chatGpt
      ? { apiKey: "codex-app-server", source: "codex-app-server", mode: "token" }
      : { apiKey: "sk-test", source: "env:TEST_API_KEY", mode: "api-key" },
  };
}

type LocalAudioSelection = Awaited<ReturnType<typeof inspectLocalAudioSelection>>;

const closeEmbeddingProviderMock = vi.hoisted(() => vi.fn(async () => {}));
const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  loadConfig: vi.fn(() => ({})),
  getRuntimeConfigSourceSnapshot: vi.fn(() => null),
  setRuntimeConfigSnapshot: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn<
    typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime
  >(() => ({ version: 1, profiles: {}, order: {} })),
  listProfilesForProvider: vi.fn<
    typeof import("../agents/auth-profiles.js").listProfilesForProvider
  >(() => []),
  resolveApiKeyForProviderCore: vi.fn<
    typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore
  >(async () => {
    throw new Error("no auth profile");
  }),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/agent-${agentId}`),
  updateAuthProfileStoreWithLock: vi.fn(
    async ({ updater }: { updater: (store: any) => boolean }) => {
      const store = {
        version: 1,
        profiles: {},
        order: {},
        lastGood: {},
        usageStats: {},
      };
      updater(store);
      return store;
    },
  ),
  resolveMemorySearchConfig: vi.fn<
    typeof import("../agents/memory-search.js").resolveMemorySearchConfig
  >(() => null),
  loadModelCatalog: vi.fn<
    typeof import("../agents/prepared-model-catalog.js").readPreparedModelCatalog
  >(async () => [{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4" }]),
  releaseSimpleCompletion: vi.fn(),
  acquireSimpleCompletionModelForAgent: vi.fn(async () => preparedModel()),
  completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
    content: [{ type: "text", text: "local reply" }],
  })),
  callGateway: vi.fn(async ({ method }: { method: string }) => {
    if (method === "tts.status") {
      return { enabled: true, provider: "openai" };
    }
    if (method === "tts.convert") {
      return {
        audioPath: "/tmp/gateway-tts.mp3",
        provider: "openai",
        outputFormat: "mp3",
        voiceCompatible: false,
      };
    }
    if (method === "agent") {
      return {
        result: {
          payloads: [{ text: "gateway reply" }],
          meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        },
      };
    }
    return {};
  }),
  describeImageFile: vi.fn(async () => ({
    text: "friendly lobster",
    provider: "openai",
    model: "gpt-4.1-mini",
  })),
  prepareImageDescriptionInput: vi.fn(async () => ({
    buffer: Buffer.from("image"),
    fileName: "photo.jpg",
    mime: "image/jpeg",
  })),
  describePreparedImageWithModel: vi.fn(async () => ({
    text: "friendly lobster",
    model: "gpt-4.1-mini",
  })),
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: vi.fn(() => []),
  generateVideo: vi.fn(),
  describeVideoFile: vi.fn(async () => ({ text: "friendly lobster" })),
  listRuntimeVideoGenerationProviders: vi.fn(() => []),
  transcribeAudioFile: vi.fn<
    typeof import("../media-understanding/runtime.js").transcribeAudioFile
  >(async () => ({ text: "meeting notes" })),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts-source.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
    attempts: [],
  })),
  setTtsProvider: vi.fn(),
  getTtsProvider: vi.fn(() => "openai"),
  listSpeechProviders: vi.fn(() => []),
  setTtsPersona: vi.fn(),
  resolveTtsConfig: vi.fn(() => ({ providerConfigs: {} })),
  resolveExplicitTtsOverrides: vi.fn(
    ({
      provider,
      modelId,
      voiceId,
    }: {
      provider?: string;
      modelId?: string;
      voiceId?: string;
    }) => ({
      ...(provider ? { provider } : {}),
      ...(modelId || voiceId
        ? {
            providerOverrides: {
              [provider ?? "openai"]: {
                ...(modelId ? { modelId } : {}),
                ...(voiceId ? { voiceId } : {}),
              },
            },
          }
        : {}),
    }),
  ),
  getProviderEnvVarsCore: vi.fn((providerId: string) => [
    `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`,
  ]),
  embedBatch: vi.fn(async (inputs: unknown[], options?: { inputType?: string }) =>
    inputs.map(() => (options?.inputType === "document" ? [0.1, 0.2] : [9, 9])),
  ),
  createEmbeddingProvider: vi.fn(async () => ({
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embed: async () => [0.1, 0.2],
      embedBatch: (...args: Parameters<typeof mocks.embedBatch>) => mocks.embedBatch(...args),
      close: closeEmbeddingProviderMock,
    },
  })),
  listMemoryEmbeddingProviders: vi.fn(() => [
    { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
  ]),
  listEmbeddingProviders: vi.fn(() => []),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  inspectLocalAudioSelection: vi.fn<() => Promise<LocalAudioSelection>>(async () => ({
    candidates: [],
    entries: [],
  })),
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
  listWebSearchProviders: vi.fn<typeof import("../web-search/runtime.js").listWebSearchProviders>(
    () => [],
  ),
  isWebSearchProviderConfigured: vi.fn<
    typeof import("../web-search/runtime.js").isWebSearchProviderConfigured
  >(() => false),
  isWebFetchProviderConfigured: vi.fn(() => false),
  getModelsCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getMemoryEmbeddingCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getTtsCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getCapabilityWebSearchCommandSecretTargets: vi.fn(
    (
      config: { tools?: { web?: { search?: { provider?: string } } } },
      options?: { providerId?: string },
    ) => {
      const providerId = options?.providerId ?? config.tools?.web?.search?.provider ?? "tavily";
      const pathValue = `plugins.entries.${providerId}.config.webSearch.apiKey`;
      return {
        targetIds: new Set([pathValue]),
        ...(options?.providerId ? { forcedActivePaths: new Set([pathValue]) } : {}),
      };
    },
  ),
  getCapabilityWebFetchCommandSecretTargets: vi.fn(
    (
      _config: { tools?: { web?: { fetch?: { provider?: string } } } },
      options?: { providerId?: string },
    ) => {
      const pathLocal =
        options?.providerId === "firecrawl"
          ? "plugins.entries.firecrawl.config.webSearch.apiKey"
          : "plugins.entries.firecrawl.config.webFetch.apiKey";
      return {
        targetIds: new Set([pathLocal]),
        ...(options?.providerId ? { forcedActivePaths: new Set([pathLocal]) } : {}),
      };
    },
  ),
  resolveCommandConfigWithSecrets: vi.fn(
    async ({ config }: { config: Record<string, unknown> }) => ({
      resolvedConfig: config,
      effectiveConfig: config,
      diagnostics: [],
    }),
  ),
  modelsStatusCommand: vi.fn(
    async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
      runtime.log(JSON.stringify({ ok: true, providers: [{ id: "openai" }] }));
    },
  ),
  modelsAuthLoginCommand: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVarsCore: mocks.getProviderEnvVarsCore,
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  setRuntimeConfigSnapshot: mocks.setRuntimeConfigSnapshot,
}));

vi.mock("./command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("./command-secret-targets.js", () => ({
  getCapabilityWebFetchCommandSecretTargets: mocks.getCapabilityWebFetchCommandSecretTargets,
  getCapabilityWebSearchCommandSecretTargets: mocks.getCapabilityWebSearchCommandSecretTargets,
  getMemoryEmbeddingCommandSecretTargetIds: mocks.getMemoryEmbeddingCommandSecretTargetIds,
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
  getTtsCommandSecretTargetIds: mocks.getTtsCommandSecretTargetIds,
}));

// Account-secret snapshot preparation is covered by dedicated
// model.account-secrets.* and local-runners.account-secrets tests; keep this
// command-wiring suite on the pre-existing mocked world instead of loading the
// real secrets runtime.
vi.mock("./capability-cli/local-account-secrets.js", () => ({
  prepareLocalCapabilityAccountSecrets: vi.fn(async () => {}),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentConfig: () => ({}),
  resolveAgentEffectiveModelPrimary: (
    cfg: {
      agents?: {
        defaults?: { model?: string };
        entries?: Record<string, { model?: string }>;
      };
    },
    agentId: string,
  ) => cfg.agents?.entries?.[agentId]?.model ?? cfg.agents?.defaults?.model,
  resolveAgentModelFallbacksOverride: () => [],
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: mocks.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: mocks.completeWithPreparedSimpleCompletionModel,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForRuntime: mocks.loadAuthProfileStoreForRuntime,
  listProfilesForProvider: mocks.listProfilesForProvider,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore: mocks.resolveApiKeyForProviderCore,
}));

vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: mocks.updateAuthProfileStoreWithLock,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: mocks.resolveMemorySearchConfig,
}));

vi.mock("../commands/models/auth.js", () => ({
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
}));

vi.mock("../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: mocks.modelsStatusCommand,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  randomIdempotencyKey: () => "run-1",
}));

vi.mock("../media-understanding/runtime.js", () => ({
  describeImageFile: mocks.describeImageFile,
  prepareImageDescriptionInput: mocks.prepareImageDescriptionInput,
  describePreparedImageWithModel: mocks.describePreparedImageWithModel,
  describeVideoFile: mocks.describeVideoFile,
  transcribeAudioFile: mocks.transcribeAudioFile,
}));

vi.mock("../media-understanding/provider-registry.js", () => ({
  buildMediaUnderstandingRegistry: mocks.buildMediaUnderstandingRegistry,
}));

vi.mock("../media-understanding/local-audio.js", () => ({
  inspectLocalAudioSelection: mocks.inspectLocalAudioSelection,
}));

vi.mock("../media/media-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/media-services.js")>();
  return {
    ...actual,
    convertHeicToJpeg: mocks.convertHeicToJpeg,
  };
});

vi.mock("../plugins/memory-embedding-provider-runtime.js", () => ({
  listRegisteredMemoryEmbeddingProviderAdapters: mocks.listMemoryEmbeddingProviders,
}));

vi.mock("../plugins/embedding-provider-runtime.js", () => ({
  listEmbeddingProviders: mocks.listEmbeddingProviders,
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider: mocks.createEmbeddingProvider,
}));

vi.mock("../image-generation/runtime.js", () => ({
  generateImage: (...args: unknown[]) => mocks.generateImage(...args),
  listRuntimeImageGenerationProviders: mocks.listRuntimeImageGenerationProviders,
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: mocks.listRuntimeVideoGenerationProviders,
}));

vi.mock("../tts/tts.js", () => ({
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: mocks.getTtsProvider,
  listTtsPersonas: vi.fn(() => []),
  listSpeechVoices: vi.fn(async () => []),
  resolveTtsConfig: mocks.resolveTtsConfig,
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  setTtsEnabled: vi.fn(),
  setTtsPersona: mocks.setTtsPersona,
  setTtsProvider: mocks.setTtsProvider,
  resolveExplicitTtsOverrides: mocks.resolveExplicitTtsOverrides,
  textToSpeech: mocks.textToSpeech,
}));

vi.mock("../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  listSpeechProviders: mocks.listSpeechProviders,
  normalizeSpeechProviderId: vi.fn(
    (provider: string | undefined) => provider?.trim().toLowerCase() || undefined,
  ),
}));

vi.mock("../web-search/runtime.js", () => ({
  listWebSearchProviders: mocks.listWebSearchProviders,
  isWebSearchProviderConfigured: mocks.isWebSearchProviderConfigured,
  runWebSearch: vi.fn(),
}));

vi.mock("../web-fetch/runtime.js", () => ({
  listWebFetchProviders: vi.fn(() => []),
  isWebFetchProviderConfigured: mocks.isWebFetchProviderConfigured,
  resolveWebFetchDefinition: vi.fn(),
}));

describe("capability cli", () => {
  it.each([
    {
      root: "infer",
      args: ["image", "edit", "--prompt", "crop the image"],
      option: "--file <path>",
    },
    { root: "capability", args: ["image", "describe-many"], option: "--file <path>" },
    { root: "infer", args: ["embedding", "create"], option: "--text <text>" },
  ])(
    "rejects missing required repeatable input for $root $args",
    async ({ root, args, option }) => {
      const argv = [root, ...args, "--json"];
      const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      await registerCapabilityCli(program, ["node", "openclaw", ...argv]);

      await expect(
        program.parseAsync(argv, { from: "user" }).then(() => undefined),
      ).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
        message: `error: required option '${option}' not specified`,
      });
      expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
      expect(mocks.generateImage).not.toHaveBeenCalled();
      expect(mocks.describeImageFile).not.toHaveBeenCalled();
      expect(mocks.createEmbeddingProvider).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { runtime, ...functions } = mocks;
    for (const mock of Object.values(runtime)) {
      mock.mockClear();
    }
    for (const mock of Object.values(functions)) {
      mock.mockReset();
    }
    closeEmbeddingProviderMock.mockReset();
  });

  const runModelProbe = (...args: string[]) =>
    runCapability("model", "run", "--prompt", "hello", ...args, "--json");
  const convertTts = (...args: string[]) =>
    runCapability("tts", "convert", "--text", "hello", ...args, "--json");
  const generateVideo = (...args: string[]) =>
    runCapability("video", "generate", "--prompt", "friendly lobster", ...args, "--json");
  const generateImage = (...args: string[]) =>
    runCapability("image", "generate", "--prompt", "friendly lobster", ...args, "--json");

  type GatewayCall = {
    clientName?: unknown;
    method?: unknown;
    mode?: unknown;
    params?: Record<string, unknown>;
    scopes?: unknown;
  };
  type CompletionCall = {
    context?: {
      messages?: Array<{ content?: unknown; role?: unknown }>;
      systemPrompt?: unknown;
    };
    options?: { reasoning?: unknown };
  };
  type ImageDescribeParams = {
    agentId?: string;
    agentDir?: string;
    filePath?: string;
    mediaUrl?: string;
    model?: unknown;
    prompt?: unknown;
    provider?: unknown;
    timeoutMs?: unknown;
  };

  function firstGatewayCall() {
    const calls = mocks.callGateway.mock.calls as unknown as Array<[GatewayCall]>;
    return calls[0]?.[0];
  }

  function firstCompletionCall() {
    const calls = mocks.completeWithPreparedSimpleCompletionModel.mock.calls as unknown as Array<
      [CompletionCall]
    >;
    return calls[0]?.[0];
  }

  function firstPreparedModelParams() {
    const calls = mocks.acquireSimpleCompletionModelForAgent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return calls[0]?.[0];
  }

  function firstJsonOutput() {
    const calls = mocks.runtime.writeJson.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function imageDescribeCall(index = 0) {
    const calls = mocks.describeImageFile.mock.calls as unknown as Array<[ImageDescribeParams]>;
    return calls[index]?.[0];
  }

  function firstImagePrepareCall() {
    const calls = mocks.prepareImageDescriptionInput.mock.calls as unknown as Array<
      [ImageDescribeParams]
    >;
    return calls[0]?.[0];
  }

  function firstImageDescribeWithModelCall() {
    const calls = mocks.describePreparedImageWithModel.mock.calls as unknown as Array<
      [ImageDescribeParams]
    >;
    return calls[0]?.[0];
  }

  function firstImageGenerationCall() {
    const calls = mocks.generateImage.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function firstVideoGenerationCall() {
    const calls = mocks.generateVideo.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  async function outputFixture(extension: string, original: string) {
    const dir = tempDirs.make("capability-output-");
    const outputBase = path.join(dir, "result");
    const outputPath = `${outputBase}${extension}`;
    await fs.writeFile(outputPath, original);
    await fs.chmod(outputPath, 0o640);
    return { dir, outputBase, outputPath };
  }

  async function expectOutputFile(
    fixture: Awaited<ReturnType<typeof outputFixture>>,
    contents: string,
  ) {
    expect(await fs.readFile(fixture.outputPath, "utf8")).toBe(contents);
    if (process.platform !== "win32") {
      expect((await fs.stat(fixture.outputPath)).mode & 0o777).toBe(0o640);
    }
    expect(await fs.readdir(fixture.dir)).toEqual([path.basename(fixture.outputPath)]);
  }

  function mockVideoFetch(
    body: ConstructorParameters<typeof Response>[0],
    init: ResponseInit = { headers: { "content-type": "video/mp4" } },
  ) {
    const fetchMock = vi.fn(async () => new Response(body, init));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function primeGeneratedVideoUrl(url: string): void {
    mocks.generateVideo.mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      videos: [{ url, mimeType: "video/mp4", fileName: "provider-name.mp4" }],
    });
  }

  function primeImageFallback() {
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig: {},
      effectiveConfig: {
        agents: {
          defaults: {
            imageModel: {
              primary: "openrouter/google/gemma-4-31b-it:free",
              fallbacks: ["openrouter/google/gemma-4-31b-it"],
            },
          },
        },
      },
      diagnostics: [],
    });
  }

  function primeChatGptModel(provider: string, modelId: string) {
    mocks.acquireSimpleCompletionModelForAgent.mockResolvedValueOnce(
      preparedModel(provider, modelId, true),
    );
  }

  function primeGeneratedImage(
    model: string,
    fileName: string,
    buffer = Buffer.from("png-bytes"),
  ): void {
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model,
      attempts: [],
      images: [{ buffer, mimeType: "image/png", fileName }],
    });
  }

  function firstTextToSpeechCall() {
    const calls = mocks.textToSpeech.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]?.[0];
  }

  function firstEmbeddingProviderCall() {
    const calls = mocks.createEmbeddingProvider.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return calls[0]?.[0];
  }

  function runtimeErrorMessages(): string[] {
    return mocks.runtime.error.mock.calls.map((call) => String(call[0] ?? ""));
  }

  function expectRuntimeErrorContains(expected: string): void {
    expect(runtimeErrorMessages().join("\n")).toContain(expected);
  }

  it.each(["list", "inspect"])("queries capability metadata through %s", async (action) => {
    await runCap(
      "capability",
      action,
      ...(action === "inspect" ? ["--name", "image.edit"] : []),
      "--json",
    );
    if (action === "inspect") {
      expect(firstJsonOutput()).toMatchObject({ id: "image.edit", transports: ["local"] });
    } else {
      const payload = (firstJsonOutput() as unknown as Array<{ id: string }> | undefined) ?? [];
      const ids = payload.map((entry) => entry.id);
      expect(ids).toContain("model.run");
      expect(ids).toContain("image.describe");
    }
  });

  it("renders an explicit empty model list without changing JSON output", async () => {
    mocks.loadModelCatalog.mockResolvedValue([]);

    await runCapability("model", "list", "--json");
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith([]);

    await runCapability("model", "list");
    expect(mocks.runtime.log).toHaveBeenCalledWith("No results found.");
  });

  it.each([true, false])(
    "inspects the requested agent's catalog (model present: %s)",
    async (present) => {
      mocks.loadConfig.mockReturnValue({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, work: {} },
        },
      });
      const workModel = { provider: "catalog-fixture", id: "work-model", name: "Work model" };
      mocks.loadModelCatalog.mockImplementation(async (params) =>
        params?.agentId === "work" && present ? [workModel] : [],
      );
      const model = present ? "catalog-fixture/work-model" : "cerebras/gpt-oss-120b";
      const run = runCap(
        "infer",
        "model",
        "--agent",
        "work",
        "inspect",
        "--model",
        model,
        "--json",
      );
      if (present) {
        await run;
        expect(mocks.runtime.writeJson).toHaveBeenCalledWith(workModel);
      } else {
        await expect(run).rejects.toThrow("exit 1");
        expectRuntimeErrorContains("Model not found: cerebras/gpt-oss-120b");
        expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      }
      expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
        config: mocks.loadConfig(),
        agentId: "work",
        readOnly: true,
      });
    },
  );

  it("canonicalizes an infer model run override using the requested agent's catalog", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    });
    mocks.loadModelCatalog.mockImplementation(async (params) =>
      params?.agentId === "work"
        ? [{ provider: "catalog-fixture", id: "Work-Model", name: "Work model" }]
        : [],
    );

    await runCap(
      "infer",
      "model",
      "--agent",
      "work",
      "run",
      "--model",
      "catalog-fixture/WORK-MODEL@work",
      "--prompt",
      "hello",
      "--json",
    );

    expect(firstPreparedModelParams()).toMatchObject({
      agentId: "work",
      modelRef: "catalog-fixture/Work-Model@work",
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
    });
  });

  it("scopes provider state and model selection to an explicit agent", async () => {
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "beta" } },
        entries: {
          alpha: { model: "anthropic/claude-sonnet-4-6" },
          beta: { model: "openai/gpt-5.4" },
        },
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);
    mocks.loadModelCatalog.mockResolvedValueOnce([
      { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude" },
      { id: "gpt-5.4", provider: "openai", name: "GPT" },
    ] as never);
    mocks.loadAuthProfileStoreForRuntime.mockImplementation(
      (agentDir) =>
        ({
          profiles:
            agentDir === "/tmp/agent-alpha"
              ? { "anthropic:alpha": { provider: "anthropic" } }
              : { "openai:beta": { provider: "openai" } },
          order: {},
        }) as never,
    );
    mocks.listProfilesForProvider.mockImplementation((store, provider) =>
      Object.entries(store.profiles as Record<string, { provider: string }>)
        .filter(([, profile]) => profile.provider === provider)
        .map(([id]) => id),
    );

    await runCapability("model", "providers", "--agent", "alpha", "--json");

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      agentId: "alpha",
      readOnly: true,
    });
    expect(mocks.resolveAgentDir.mock.calls.map((call) => call[1])).toEqual(["alpha", "alpha"]);
    expect(firstJsonOutput()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", configured: true, selected: true }),
        expect.objectContaining({ provider: "openai", configured: false, selected: false }),
      ]),
    );
  });

  it("requires an explicit owner for agent-backed provider state in explicit fleets", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    });

    // Agent selection is an expected CLI condition rendered by the root failure
    // owner; the command rethrows instead of printing its own copy.
    await expect(runCapability("audio", "providers", "--json")).rejects.toMatchObject({
      name: "AgentSelectionRequiredError",
      message: expect.stringMatching(
        /inference provider inspection has no explicit owner[\s\S]*Pass --agent <id> or set agents\.defaults\.systemAgent\.agentId/,
      ),
    });
    expect(runtimeErrorMessages()).toEqual([]);
    expect(mocks.loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "inspects web provider state with explicit agent selection %s",
    async (scoped) => {
      mocks.loadConfig.mockReturnValue(
        scoped
          ? { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } }
          : {
              tools: { web: { search: { provider: "gemini" }, fetch: { provider: "firecrawl" } } },
            },
      );
      const provider = { id: "openai", envVars: ["OPENAI_API_KEY"], requiresCredential: true };
      const search = await import("../web-search/runtime.js");
      const fetch = await import("../web-fetch/runtime.js");
      vi.mocked(search.listWebSearchProviders).mockReturnValue(
        scoped
          ? ([provider] as never)
          : [
              { id: "brave", envVars: ["BRAVE_API_KEY"] } as never,
              { id: "gemini", envVars: ["GEMINI_API_KEY"] } as never,
            ],
      );
      vi.mocked(fetch.listWebFetchProviders).mockReturnValueOnce(
        scoped ? [] : [{ id: "firecrawl", envVars: ["FIRECRAWL_API_KEY"] } as never],
      );
      if (!scoped) {
        mocks.isWebSearchProviderConfigured.mockReturnValueOnce(false).mockReturnValueOnce(true);
        mocks.isWebFetchProviderConfigured.mockReturnValueOnce(true);
      }
      await runCapability("web", "providers", ...(scoped ? ["--agent", "beta"] : []), "--json");
      if (scoped) {
        expect(firstJsonOutput()).toMatchObject({ search: [{ id: "openai" }], fetch: [] });
        expect(mocks.isWebSearchProviderConfigured).toHaveBeenCalledWith({
          provider,
          config: mocks.loadConfig(),
          agentDir: "/tmp/agent-beta",
        });
      } else {
        expect(firstJsonOutput()).toMatchObject({
          search: [
            { id: "brave", configured: false, selected: false },
            { id: "gemini", configured: true, selected: true },
          ],
          fetch: [{ id: "firecrawl", configured: true, selected: true }],
        });
      }
    },
  );

  it.each([false, true])(
    "prepares local model content and instructions (ChatGPT API: %s)",
    async (chatGpt) => {
      const tempInput = path.join(tempDirs.make("openclaw-model-run-image-"), "input.png");
      if (chatGpt) {
        primeChatGptModel("openai", "gpt-5.5");
      } else {
        await fs.writeFile(tempInput, Buffer.from(PNG_1X1_BASE64, "base64"));
      }
      await runCapability(
        "model",
        "run",
        "--prompt",
        chatGpt ? "hello" : "describe this",
        ...(chatGpt ? ["--model", "openai/gpt-5.5"] : ["--file", tempInput, "--thinking", "high"]),
        "--json",
      );
      const call = firstCompletionCall();
      expect(call?.context?.messages?.[0]?.role).toBe("user");
      if (chatGpt) {
        expect(call?.context?.systemPrompt).toBe(
          "You are a personal assistant running inside OpenClaw.",
        );
        expect(call?.context?.messages?.[0]?.content).toBe("hello");
      } else {
        expect(call?.options?.reasoning).toBe("high");
        expect(firstJsonOutput()?.transport).toBe("local");
        expect(mocks.callGateway).not.toHaveBeenCalled();
        expect(call?.context?.messages?.[0]?.content).toEqual([
          { type: "text", text: "describe this" },
          { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
        ]);
        expect(call?.context).not.toHaveProperty("systemPrompt");
        const inputs = firstJsonOutput()?.inputs as Array<{ mimeType?: unknown; path?: unknown }>;
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.path).toBe(tempInput);
        expect(inputs[0]?.mimeType).toBe("image/png");
      }
    },
  );

  it("normalizes HEIF sequence images before Gateway probes", async () => {
    const fileName = "opaque.bin";
    const source = Buffer.alloc(24);
    source.writeUInt32BE(source.length, 0);
    source.write("ftyp", 4, "ascii");
    source.write("msf1", 8, "ascii");
    const tempInput = path.join(tempDirs.make("openclaw-model-run-heif-sequence-"), fileName);
    await fs.writeFile(tempInput, source);

    await runModelProbe("--file", tempInput, "--gateway");

    expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(source);
    expect(firstGatewayCall()?.params?.attachments).toEqual([
      {
        type: "image",
        fileName,
        mimeType: "image/jpeg",
        content: Buffer.from("jpeg-normalized").toString("base64"),
      },
    ]);
    expect(firstJsonOutput()?.inputs).toEqual([{ path: tempInput, mimeType: "image/jpeg" }]);
  });

  it("rejects non-image files for model probes", async () => {
    const tempInput = path.join(os.tmpdir(), `openclaw-model-run-audio-${Date.now()}.mp3`);
    await fs.writeFile(tempInput, Buffer.from("not really audio"));

    await expect(runModelProbe("--file", tempInput)).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Only image files are supported");
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      errorMessage: undefined,
      expected: 'No text output returned for provider "openai" model "gpt-5.4"',
    },
    {
      errorMessage: '{"detail":"Instructions are required"}',
      expected: '{"detail":"Instructions are required"}',
    },
  ])(
    "reports empty local model output with provider error $errorMessage",
    async ({ errorMessage, expected }) => {
      mocks.completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
        content: [],
        ...(errorMessage ? { stopReason: "error", errorMessage } : {}),
      } as never);
      await expect(runModelProbe()).rejects.toThrow("exit 1");
      expectRuntimeErrorContains(expected);
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("rejects local Codex provider probes before simple-completion dispatch", async () => {
    primeChatGptModel("codex", "gpt-5.4");

    await expect(runModelProbe("--model", "codex/gpt-5.4")).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("Codex app-server agent runtime");
    expect(mocks.releaseSimpleCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["--prompt", "\n\t"], error: "--prompt cannot be empty or whitespace-only." },
    {
      args: ["--model", "not-a-provider/"],
      error: "Model overrides must use the form <provider/model>.",
    },
    { args: ["--thinking", "turbo-mode"], error: "Invalid thinking level." },
  ])("rejects invalid model run options $args before dispatch", async ({ args, error }) => {
    await expect(runModelProbe(...args)).rejects.toThrow("exit 1");
    expectRuntimeErrorContains(error);
    expect(mocks.acquireSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    expect(mocks.completeWithPreparedSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("runs gateway model probes in fresh raw sessions without chat-agent prompt policy or tools", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "gateway fallback reply" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-4.1-mini",
            fallbackAttempts: [
              {
                provider: "openrouter",
                model: "openrouter/auto",
                error: "model unavailable",
                reason: "model_not_found",
              },
            ],
          },
        },
      },
    } as never);

    await runModelProbe("--gateway");

    const payload = firstJsonOutput();
    const attempts = payload?.attempts as Array<Record<string, unknown>>;
    expect(payload?.provider).toBe("openai");
    expect(payload?.model).toBe("gpt-4.1-mini");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.provider).toBe("openrouter");
    expect(attempts[0]?.model).toBe("openrouter/auto");
    expect(attempts[0]?.reason).toBe("model_not_found");

    const gatewayCall = firstGatewayCall();
    const sessionId = gatewayCall?.params?.sessionId;
    expect(gatewayCall?.method).toBe("agent");
    expect(sessionId).toEqual(expect.stringMatching(/^model-run-[0-9a-f-]{36}$/));
    expect(gatewayCall?.params?.sessionKey).toBe(`agent:main:explicit:${String(sessionId)}`);
    expect(gatewayCall?.params?.cleanupBundleMcpOnRunEnd).toBe(true);
    expect(gatewayCall?.params?.modelRun).toBe(true);
    expect(gatewayCall?.params?.promptMode).toBe("none");

    await runCapability("model", "run", "--prompt", "again", "--gateway", "--json");

    const gatewayCalls = mocks.callGateway.mock.calls as unknown as Array<[GatewayCall]>;
    const nextGatewayCall = gatewayCalls[1]?.[0];
    const nextSessionId = nextGatewayCall?.params?.sessionId;
    expect(nextGatewayCall?.method).toBe("agent");
    expect(nextSessionId).toEqual(expect.stringMatching(/^model-run-[0-9a-f-]{36}$/));
    expect(nextGatewayCall?.params?.sessionKey).toBe(
      `agent:main:explicit:${String(nextSessionId)}`,
    );
    expect(nextSessionId).not.toBe(sessionId);
  });

  it.each([
    {
      model: "Anthropic/CLAUDE-HAIKU-4-5",
      catalogId: "claude-haiku-4-5",
      name: "Haiku",
      provider: "anthropic",
      forwardedModel: "claude-haiku-4-5",
      thinking: true,
    },
    {
      model: "Anthropic/CLAUDE-OPUS-4-7@work",
      catalogId: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      provider: "Anthropic",
      forwardedModel: "CLAUDE-OPUS-4-7@work",
      thinking: false,
    },
  ])(
    "authorizes Gateway model override $model and preserves profile refs",
    async ({ model, catalogId, name, provider, forwardedModel, thinking }) => {
      mocks.loadModelCatalog.mockResolvedValueOnce([
        { id: catalogId, provider: "anthropic", name },
      ]);
      await runModelProbe(
        "--gateway",
        "--model",
        model,
        ...(thinking ? ["--thinking", "high"] : []),
      );
      if (thinking) {
        expect(firstGatewayCall()?.params?.thinking).toBe("high");
        expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: true }),
        );
      }
      expect(firstGatewayCall()).toMatchObject({
        clientName: "gateway-client",
        method: "agent",
        mode: "backend",
        scopes: ["operator.admin"],
        params: { provider, model: forwardedModel, modelRun: true, promptMode: "none" },
      });
    },
  );

  it("defaults tts status to gateway transport", async () => {
    await runCapability("tts", "status", "--json");

    expect(firstGatewayCall()?.method).toBe("tts.status");
    expect(firstJsonOutput()?.transport).toBe("gateway");
  });

  it("rejects conflicting TTS persona selectors before dispatch", async () => {
    const argv = ["infer", "tts", "set-persona", "--persona", "work", "--off", "--local", "--json"];
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    await registerCapabilityCli(program, ["node", "openclaw", ...argv]);
    await expect(program.parseAsync(argv, { from: "user" })).rejects.toMatchObject({
      code: "commander.conflictingOption",
      message: "error: option '--persona <id>' cannot be used with option '--off'",
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.setTtsPersona).not.toHaveBeenCalled();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("prints anonymous video descriptions with their input path", async () => {
    await runCapability("video", "describe", "--file", "clip.mp4");
    const output = mocks.runtime.log.mock.calls.at(-1)?.[0];
    expect(output).toContain(path.resolve("clip.mp4"));
    expect(output).toContain("friendly lobster");
    expect(output).not.toContain("provider:");
    expect(output).not.toContain("model:");
  });

  it.each([
    {
      action: "describe",
      files: ["https://cdn.example.com/clip%2Emp4?download=1#preview"],
      model: undefined,
      prompt: undefined,
      timeoutMs: undefined,
    },
    {
      action: "describe",
      files: ["https://example.com/photo.png"],
      model: "ollama/qwen2.5vl:7b",
      prompt: "Count visible buttons",
      timeoutMs: 120000,
    },
    {
      action: "describe-many",
      files: ["a.jpg", "b.jpg"],
      model: undefined,
      prompt: "Extract all visible labels",
      timeoutMs: 45000,
    },
  ])(
    "describes $files through $action with model $model",
    async ({ action, files, model, prompt, timeoutMs }) => {
      await runCapability(
        "image",
        action,
        ...files.flatMap((file) => ["--file", file]),
        ...(model ? ["--model", model] : []),
        ...(prompt ? ["--prompt", prompt] : []),
        ...(timeoutMs ? ["--timeout-ms", String(timeoutMs)] : []),
        "--json",
      );
      if (model) {
        expect(firstImagePrepareCall()).toMatchObject({ filePath: files[0], mediaUrl: files[0] });
        expect(firstImageDescribeWithModelCall()).toMatchObject({
          provider: "ollama",
          model: "qwen2.5vl:7b",
          prompt,
          timeoutMs,
        });
        expect(firstJsonOutput()).toMatchObject({ provider: "ollama", model: "gpt-4.1-mini" });
        expect(mocks.describeImageFile).not.toHaveBeenCalled();
      } else {
        expect(mocks.describeImageFile).toHaveBeenCalledTimes(files.length);
        for (const [index, file] of files.entries()) {
          const call = imageDescribeCall(index);
          if (action === "describe-many") {
            expect(path.basename(call?.filePath ?? "")).toBe(file);
            expect(call?.prompt).toBe(prompt);
            expect(call?.timeoutMs).toBe(timeoutMs);
          } else {
            expect(call).toMatchObject({ filePath: file, mediaUrl: file });
          }
        }
      }
      if (action === "describe") {
        const outputs = firstJsonOutput()?.outputs as Array<Record<string, unknown>>;
        expect(outputs[0]?.path).toBe(files[0]);
      }
    },
  );

  it("prepares input once before retrying explicit image models", async () => {
    primeImageFallback();
    mocks.describePreparedImageWithModel
      .mockRejectedValueOnce(new Error("upstream 429 rate limit"))
      .mockResolvedValueOnce({ text: "fallback description", model: "google/gemma-4-31b-it" });
    await runCapability(
      "image",
      "describe",
      "--file",
      "photo.jpg",
      "--model",
      "openrouter/google/gemma-4-31b-it:free",
      "--json",
    );
    expect(mocks.prepareImageDescriptionInput).toHaveBeenCalledTimes(1);
    const calls = mocks.describePreparedImageWithModel.mock.calls as unknown as Array<
      [ImageDescribeParams]
    >;
    expect(calls.map(([call]) => `${String(call.provider)}/${String(call.model)}`)).toEqual([
      "openrouter/google/gemma-4-31b-it:free",
      "openrouter/google/gemma-4-31b-it",
    ]);
    expect(firstJsonOutput()).toMatchObject({
      ok: true,
      capability: "image.describe",
      provider: "openrouter",
      model: "google/gemma-4-31b-it",
      attempts: [
        {
          provider: "openrouter",
          model: "google/gemma-4-31b-it:free",
          error: "upstream 429 rate limit",
        },
      ],
      outputs: [{ text: "fallback description", model: "google/gemma-4-31b-it" }],
    });
  });

  it.each([
    {
      domain: "image",
      action: "describe",
      file: "photo.jpg",
      missing: false,
      error: `No description returned for image: ${path.resolve("photo.jpg")}`,
    },
    {
      domain: "image",
      action: "describe",
      file: "photo.jpg",
      missing: true,
      error: "No image understanding provider is configured or ready",
      hint: "agents.defaults.imageModel.primary",
    },
    {
      domain: "audio",
      action: "transcribe",
      file: "memo.m4a",
      missing: false,
      error: `No transcript returned for audio: ${path.resolve("memo.m4a")}`,
    },
    {
      domain: "audio",
      action: "transcribe",
      file: "memo.m4a",
      missing: true,
      error: "No audio transcription provider is configured or ready",
      hint: "tools.media.models",
    },
  ])(
    "reports empty $domain results (missing provider: $missing)",
    async ({ domain, action, file, missing, error, hint }) => {
      const runtime = domain === "image" ? mocks.describeImageFile : mocks.transcribeAudioFile;
      runtime.mockResolvedValueOnce({
        text: undefined,
        ...(missing
          ? {
              decision: {
                capability: domain,
                outcome: "skipped",
                attachments: [{ attachmentIndex: 0, attempts: [] }],
              },
            }
          : {}),
      } as never);
      await expect(runCapability(domain, action, "--file", file, "--json")).rejects.toThrow(
        "exit 1",
      );
      if (missing) {
        expectRuntimeErrorContains(error);
        expectRuntimeErrorContains(hint!);
      } else {
        expect(runtimeErrorMessages()).toEqual([error]);
      }
    },
  );

  it("rewrites mismatched explicit image output extensions to the detected file type", async () => {
    const jpegBase64 =
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAAAER/9oADAMBAAIQAxAAAAH2AP/EABgQAQEAAwAAAAAAAAAAAAAAAAEAEQIS/9oACAEBAAEFAk1o7//EABYRAQEBAAAAAAAAAAAAAAAAAAABEf/aAAgBAwEBPwGn/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEB/9oACAECAQE/AYf/xAAaEAACAgMAAAAAAAAAAAAAAAABEQAhMUFh/9oACAEBAAY/AjK9cY2f/8QAGhABAQACAwAAAAAAAAAAAAAAAAERITFBUf/aAAgBAQABPyGQk7W5jVYkA//Z";
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      images: [
        {
          buffer: Buffer.from(jpegBase64, "base64"),
          mimeType: "image/png",
          fileName: "provider-output.png",
        },
      ],
    });

    const tempOutput = path.join(os.tmpdir(), `openclaw-image-mismatch-${Date.now()}.png`);
    await fs.rm(tempOutput, { force: true });
    await fs.rm(tempOutput.replace(/\.png$/, ".jpg"), { force: true });

    await generateImage("--output", tempOutput);

    const outputs = firstJsonOutput()?.outputs as Array<Record<string, unknown>>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.path).toBe(tempOutput.replace(/\.png$/, ".jpg"));
    expect(outputs[0]?.mimeType).toBe("image/jpeg");
  });

  it("forwards image generation options using the leaf agent", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
    });
    primeGeneratedImage("gpt-image-1", "provider-output.png");

    await runCapabilityWithParentAgent(
      "image",
      "generate",
      "alpha",
      "--agent",
      "beta",
      "--prompt",
      "portrait",
      "--quality",
      "max",
      "--openai-moderation",
      "low",
      "--json",
    );

    expect(firstImageGenerationCall()).toMatchObject({
      agentDir: "/tmp/agent-beta",
      quality: "max",
      providerOptions: { openai: { moderation: "low" } },
    });
  });

  it("passes image output format, quality, and OpenAI hints through to edit runtime", async () => {
    const png = Buffer.from(PNG_1X1_BASE64, "base64");
    primeGeneratedImage("gpt-image-1.5", "transparent-edit.png", png);
    const directory = tempDirs.make("capability-image-edit-");
    const inputPath = path.join(directory, "input.png");
    const outputPath = path.join(directory, "output.png");
    await fs.writeFile(inputPath, png);

    await runCapability(
      "image",
      "edit",
      "--file",
      inputPath,
      "--file",
      inputPath,
      "--count",
      "3",
      "--size",
      "2160x3840",
      "--aspect-ratio",
      "9:16",
      "--resolution",
      "4K",
      "--background",
      "opaque",
      "--timeout-ms",
      "180000",
      "--prompt",
      "make background transparent",
      "--model",
      "openai/gpt-image-1.5",
      "--output-format",
      "png",
      "--openai-background",
      "transparent",
      "--openai-moderation",
      "auto",
      "--quality",
      "high",
      "--output",
      outputPath,
      "--json",
    );

    const generationCall = firstImageGenerationCall();
    const inputImages = generationCall?.inputImages as Array<Record<string, unknown>>;
    expect(generationCall?.prompt).toBe("make background transparent");
    expect(generationCall?.modelOverride).toBe("openai/gpt-image-1.5");
    expect(generationCall?.outputFormat).toBe("png");
    expect(generationCall?.quality).toBe("high");
    expect(generationCall).toMatchObject({
      count: 3,
      size: "2160x3840",
      aspectRatio: "9:16",
      resolution: "4K",
      background: "opaque",
      timeoutMs: 180000,
    });
    expect(generationCall?.providerOptions).toEqual({
      openai: {
        background: "transparent",
        moderation: "auto",
      },
    });
    expect(firstJsonOutput()?.outputs).toEqual([
      expect.objectContaining({ path: outputPath, mimeType: "image/png" }),
    ]);
    expect(inputImages).toHaveLength(2);
    expect(inputImages[0]?.fileName).toBe(path.basename(inputPath));
  });

  it.each([
    ["--timeout-ms", ""],
    ["--timeout-ms", "1000ms"],
  ])("rejects invalid image option %s %j before dispatch", async (flag, value) => {
    await expect(generateImage(flag, value)).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Invalid --timeout-ms. Use a positive millisecond value");
    expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
    expect(mocks.generateVideo).not.toHaveBeenCalled();
    expect(mocks.describeImageFile).not.toHaveBeenCalled();
    expect(mocks.prepareImageDescriptionInput).not.toHaveBeenCalled();
    expect(mocks.describePreparedImageWithModel).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "downloads generated videos with private-network opt-in %s",
    async (allowPrivateNetwork) => {
      if (allowPrivateNetwork) {
        mocks.loadConfig.mockReturnValue({
          models: { providers: { vydra: { request: { allowPrivateNetwork: true } } } },
        });
      }
      const url = allowPrivateNetwork
        ? "http://127.0.0.2:40123/private-video.mp4"
        : "https://example.com/generated-video.mp4";
      primeGeneratedVideoUrl(url);
      const fetchMock = mockVideoFetch(Buffer.from("video-bytes"));
      const fixture = allowPrivateNetwork
        ? undefined
        : await outputFixture(".mp4", "previous-video");
      await generateVideo(...(fixture ? ["--output", fixture.outputBase] : []));
      const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, { signal?: unknown }]>;
      expect(fetchCalls[0]?.[0]).toBe(url);
      const output = firstJsonOutput();
      const outputs = output?.outputs as Array<Record<string, unknown>>;
      expect(output?.capability).toBe("video.generate");
      expect(output?.provider).toBe("vydra");
      expect(outputs).toHaveLength(1);
      if (fixture) {
        expect(fetchCalls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
        await expectOutputFile(fixture, "video-bytes");
        expect(outputs[0]?.path).toBe(fixture.outputPath);
        expect(outputs[0]?.mimeType).toBe("video/mp4");
        expect(outputs[0]?.size).toBe(11);
      }
    },
  );

  it("preserves an existing --output and removes its temp when a video stream fails", async () => {
    primeGeneratedVideoUrl("https://example.com/broken-video.mp4");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-video"));
        controller.error(new Error("video stream exploded"));
      },
    });
    mockVideoFetch(stream);
    const fixture = await outputFixture(".mp4", "keep-existing-video");
    const { outputBase } = fixture;
    await expect(generateVideo("--output", outputBase)).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("video stream exploded");
    await expectOutputFile(fixture, "keep-existing-video");
  });

  it("preserves buffered image output when publication fails", async () => {
    const buffer = Buffer.alloc(2_048, 0x49);
    mocks.generateImage.mockResolvedValue({
      provider: "openai",
      model: "gpt-image-2",
      attempts: [],
      images: [{ buffer, mimeType: "image/png", fileName: "generated.png" }],
    });
    const fixture = await outputFixture(".png", "existing-image");
    const { outputBase } = fixture;

    const writeFile = fs.writeFile.bind(fs);
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [filePath, data, options] = args;
      if (typeof filePath === "string" && Buffer.isBuffer(data) && data.equals(buffer)) {
        await writeFile(filePath, data.subarray(0, 17), options);
        throw new Error("injected buffered media write failure");
      }
      await writeFile(...args);
    });

    try {
      await expect(generateImage("--output", outputBase)).rejects.toThrow("exit 1");

      expectRuntimeErrorContains("injected buffered media write failure");
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      await expectOutputFile(fixture, "existing-image");
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it("blocks private-network url-only generated video downloads by default", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("http://127.0.0.2:40123/private-video.mp4?sig=secret-presigned-token");
    const fetchMock = mockVideoFetch(Buffer.from("video-bytes"));

    await expect(generateVideo()).rejects.toThrow("exit 1");

    expect(fetchMock).not.toHaveBeenCalled();
    expectRuntimeErrorContains("Blocked hostname or private/internal/special-use IP address");
    expect(runtimeErrorMessages().join("\n")).not.toContain("secret-presigned-token");
    expect(runtimeErrorMessages().join("\n")).not.toContain("/private-video.mp4");
  });

  it("passes video generation parameters through to runtime", async () => {
    mocks.generateVideo.mockResolvedValue({
      provider: "minimax",
      model: "MiniMax-Hailuo-2.3",
      attempts: [],
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          mimeType: "video/mp4",
          fileName: "provider-name.mp4",
        },
      ],
    });

    await generateVideo(
      "--model",
      "minimax/MiniMax-Hailuo-2.3",
      "--size",
      "1280x768",
      "--aspect-ratio",
      "16:9",
      "--resolution",
      "768p",
      "--duration",
      "2.5",
      "--audio",
      "--watermark",
      "--timeout-ms",
      "300000",
    );

    const videoCall = firstVideoGenerationCall();
    expect(videoCall?.prompt).toBe("friendly lobster");
    expect(videoCall?.modelOverride).toBe("minimax/MiniMax-Hailuo-2.3");
    expect(videoCall?.size).toBe("1280x768");
    expect(videoCall?.aspectRatio).toBe("16:9");
    expect(videoCall?.resolution).toBe("768P");
    expect(videoCall?.durationSeconds).toBe(2.5);
    expect(videoCall?.audio).toBe(true);
    expect(videoCall?.watermark).toBe(true);
    expect(videoCall?.timeoutMs).toBe(300000);
  });

  it("fails video generate when a provider returns an undeliverable asset", async () => {
    mocks.generateVideo.mockResolvedValue({
      provider: "vydra",
      model: "veo3",
      attempts: [],
      videos: [{ mimeType: "video/mp4" }],
    });

    await expect(generateVideo()).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Video asset at index 0 has neither buffer nor url");
  });

  it("fails closed when an url-only generated video exceeds the in-memory byte cap", async () => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/oversized-video.mp4?sig=secret-presigned-token");
    // Offer far more than the 16 MiB default video cap in 1 MiB chunks so the
    // bounded reader has to cancel mid-stream instead of buffering it all. The
    // source would yield 64 MiB if fully drained; a correct guard stops early.
    const oneMiBChunk = new Uint8Array(1024 * 1024);
    const overCapChunks = 64;
    let enqueued = 0;
    let canceled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued >= overCapChunks) {
          controller.close();
          return;
        }
        enqueued += 1;
        controller.enqueue(oneMiBChunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchMock = mockVideoFetch(oversizedBody);

    await expect(generateVideo()).rejects.toThrow("exit 1");

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(fetchCalls[0]?.[0]).toBe(
      "https://example.com/oversized-video.mp4?sig=secret-presigned-token",
    );
    expectRuntimeErrorContains("vydra generated video download exceeds 16777216 bytes");
    // Security regression guard: the overflow error must NOT echo the raw
    // provider URL (it may carry signed/tokenized access material). See the
    // sibling generated-media downloaders, which report provider + cap only.
    expect(runtimeErrorMessages().join("\n")).not.toContain("secret-presigned-token");
    expect(runtimeErrorMessages().join("\n")).not.toContain("https://example.com");
    expect(canceled).toBe(true);
    expect(enqueued).toBeLessThan(overCapChunks);
    expect(enqueued).toBeLessThanOrEqual(18);
  });

  it.each([
    {
      status: 403,
      statusText: "Forbidden",
      body: "download forbidden",
      error: "vydra generated video download failed",
    },
    {
      status: 200,
      statusText: "OK",
      body: "render still processing",
      error: "vydra generated video download: malformed video response",
    },
  ])(
    "rejects textual generated-video downloads with HTTP $status",
    async ({ status, statusText, body, error }) => {
      mocks.loadConfig.mockReturnValue({});
      primeGeneratedVideoUrl("https://example.com/private-video.mp4?sig=secret-presigned-token");
      mockVideoFetch(body, { status, statusText, headers: { "content-type": "text/plain" } });
      await expect(generateVideo()).rejects.toThrow("exit 1");
      expectRuntimeErrorContains(error);
      if (status === 403) {
        expectRuntimeErrorContains("HTTP 403");
      }
      expect(runtimeErrorMessages().join("\n")).not.toContain("secret-presigned-token");
      expect(runtimeErrorMessages().join("\n")).not.toContain("https://example.com");
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "buffered", withOutput: false },
    { mode: "streamed", withOutput: true },
  ])("rejects an empty-body url-only generated video in $mode mode", async ({ withOutput }) => {
    mocks.loadConfig.mockReturnValue({});
    primeGeneratedVideoUrl("https://example.com/empty-video.mp4");
    mockVideoFetch(Buffer.alloc(0));
    const fixture = withOutput ? await outputFixture(".mp4", "keep-existing-video") : undefined;
    await expect(
      generateVideo(...(fixture ? ["--output", fixture.outputBase] : [])),
    ).rejects.toThrow("exit 1");
    expectRuntimeErrorContains("Generated media output is empty");
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    if (fixture) {
      await expectOutputFile(fixture, "keep-existing-video");
    }
  });

  it.each([
    [
      "infer",
      ["web", "search", "--query", "ping", "--limit"],
      "",
      "--limit must be a positive integer",
    ],
    [
      "capability",
      ["video", "generate", "--prompt", "clip", "--duration"],
      "   ",
      "--duration must be a finite number",
    ],
  ] as const)(
    "rejects blank numeric input before %s %j dispatch",
    async (command, argv, raw, message) => {
      const webSearchRuntime = await import("../web-search/runtime.js");
      vi.mocked(webSearchRuntime.runWebSearch).mockClear();

      await expect(runCap(command, ...argv, raw)).rejects.toThrow("exit 1");

      expectRuntimeErrorContains(message);
      expect(mocks.resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
      expect(webSearchRuntime.runWebSearch).not.toHaveBeenCalled();
      expect(mocks.generateImage).not.toHaveBeenCalled();
      expect(mocks.generateVideo).not.toHaveBeenCalled();
    },
  );

  it("reports actual audio attribution and forwards request hints", async () => {
    mocks.transcribeAudioFile.mockResolvedValueOnce({
      text: "meeting notes",
      provider: "fixture-asr",
      model: "fixture-actual-model",
    });
    await runCap(
      "infer",
      "audio",
      "transcribe",
      "--file",
      "memo.m4a",
      "--model",
      "openai/whisper-1",
      "--language",
      "en",
      "--prompt",
      "Focus on names",
    );
    expect(mocks.transcribeAudioFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ language: "en", prompt: "Focus on names" }),
    );
    const output = mocks.runtime.log.mock.calls.at(-1)?.[0];
    expect(output).toContain("provider: fixture-asr");
    expect(output).toContain("model: fixture-actual-model");
    expect(output).toContain(path.resolve("memo.m4a"));
    expect(output).toContain("meeting notes");
  });

  it.each([
    {
      name: "default provider without a config block",
      config: {},
      args: [],
      expected: { tts: { providers: { openai: { apiKey: "profile-openai-key" } } } },
    },
    {
      name: "root provider",
      config: { tts: { providers: { openai: { voice: "coral" } } } },
      args: ["--provider", "OpenAI", "--model", "openai/gpt-4o-mini-tts", "--voice", "alloy"],
      expectedOverrides: {
        provider: "openai",
        providerOverrides: { openai: { modelId: "gpt-4o-mini-tts", voiceId: "alloy" } },
      },
      expected: {
        tts: { providers: { openai: { voice: "coral", apiKey: "profile-openai-key" } } },
      },
    },
    {
      name: "channel direct provider",
      config: { channels: { discord: { tts: { openai: { speakerVoice: "nova" } } } } },
      args: ["--channel", "discord"],
      expected: {
        channels: {
          discord: { tts: { openai: { speakerVoice: "nova", apiKey: "profile-openai-key" } } },
        },
      },
    },
  ])(
    "hydrates $name TTS config from API-key profiles",
    async ({ config, args, expected, expectedOverrides }) => {
      mocks.loadConfig.mockReturnValue(config);
      primeOpenAiAuthProfile();
      await convertTts(...args);
      expect(mocks.resolveApiKeyForProviderCore).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          cfg: config,
          credentialPrecedence: "profile-first",
        }),
      );
      expect(firstTextToSpeechCall()?.cfg).toEqual(expected);
      if (expectedOverrides) {
        expect(firstTextToSpeechCall()).toMatchObject({
          overrides: expectedOverrides,
          disableFallback: true,
        });
      }
      expect(mocks.setTtsProvider).not.toHaveBeenCalled();
      expect(mocks.setRuntimeConfigSnapshot).toHaveBeenLastCalledWith(expected, undefined);
    },
  );

  it.each([
    {
      name: "inherited channel",
      config: {
        tts: { providers: { openai: { apiKey: "config-key" } } },
        channels: { discord: { tts: { providers: { openai: { speakerVoice: "nova" } } } } },
      },
      args: ["--channel", "discord"],
      resolved: { providerConfigs: { openai: { apiKey: "config-key", speakerVoice: "nova" } } },
    },
    {
      name: "direct provider",
      config: { tts: { openai: { apiKey: "config-key" } } },
      args: ["--model", "openai/gpt-4o-mini-tts"],
      resolved: { providerConfigs: {} },
    },
    {
      name: "token profile",
      config: { tts: { provider: "openai" } },
      args: [],
      resolved: { providerConfigs: {} },
      token: true,
    },
  ])("preserves existing $name TTS credentials", async ({ config, args, resolved, token }) => {
    mocks.loadConfig.mockReturnValue(config);
    mocks.resolveTtsConfig.mockReturnValue(resolved);
    primeOpenAiAuthProfile(token ? "token" : "api-key");
    await convertTts(...args);
    if (token) {
      const cfg = firstTextToSpeechCall()?.cfg as {
        tts?: { providers?: { openai?: { apiKey?: string } } };
      };
      expect(cfg.tts?.providers?.openai?.apiKey).toBeUndefined();
    } else {
      expect(firstTextToSpeechCall()?.cfg).toEqual(config);
      expect(mocks.resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    }
  });

  it("preserves explicit TTS selection without inventing overrides", async () => {
    await convertTts("--provider", "xiaomi");
    expect(mocks.resolveExplicitTtsOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "xiaomi", modelId: undefined }),
    );
    expect(firstTextToSpeechCall()?.disableFallback).toBe(true);
  });

  it("rejects conflicting TTS provider and model selections", async () => {
    await expect(
      convertTts("--provider", "xiaomi", "--model", "openai/gpt-4o-mini-tts"),
    ).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("TTS --provider must match the provider in --model.");
  });

  it("fails clearly when gateway TTS output is requested against a remote gateway", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.com" } },
    });

    await expect(convertTts("--gateway", "--output", "hello.mp3")).rejects.toThrow("exit 1");

    expectRuntimeErrorContains("--output is not supported for remote gateway TTS yet");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("preserves Gateway TTS output when the final copy fails", async () => {
    const tempDir = tempDirs.make("openclaw-tts-copy-fail-");
    const sourcePath = path.join(tempDir, "source.mp3");
    const outputDir = path.join(tempDir, "output");
    const outputPath = path.join(outputDir, "speech.mp3");
    await fs.mkdir(outputDir);
    await fs.writeFile(sourcePath, Buffer.alloc(2_048, 0x41));
    await fs.writeFile(outputPath, "existing-speech");
    await fs.chmod(outputPath, 0o640);

    mocks.callGateway.mockResolvedValueOnce({
      audioPath: sourcePath,
      provider: "openai",
      outputFormat: "mp3",
      voiceCompatible: false,
    } as never);

    const copyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
      const [source, destination] = args;
      if (source === sourcePath) {
        const bytes = await fs.readFile(source);
        await fs.writeFile(destination, bytes.subarray(0, 17));
        throw new Error("injected TTS copy failure");
      }
      await copyFile(...args);
    });

    try {
      await expect(
        convertTts("--gateway", "--voice", "alloy", "--output", outputPath),
      ).rejects.toThrow("exit 1");

      expect(firstGatewayCall()?.method).toBe("tts.convert");
      expect(firstGatewayCall()?.params?.provider).toBeUndefined();
      expect(firstGatewayCall()?.params?.voiceId).toBe("alloy");

      expectRuntimeErrorContains("injected TTS copy failure");
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      expect(await fs.readFile(outputPath, "utf8")).toBe("existing-speech");
      if (process.platform !== "win32") {
        expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o640);
      }
      expect(await fs.readdir(outputDir)).toEqual(["speech.mp3"]);
    } finally {
      copyFileSpy.mockRestore();
    }
  });

  it("creates embeddings with explicit provider selection", async () => {
    await runCapability(
      "embedding",
      "create",
      "--text",
      "hello",
      "--text",
      "world",
      "--model",
      "openai/text-embedding-3-large",
      "--json",
    );
    expect(firstEmbeddingProviderCall()).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-large",
      fallback: "none",
    });
    expect(firstJsonOutput()).toMatchObject({
      capability: "embedding.create",
      provider: "openai",
      model: "text-embedding-3-small",
      outputs: [
        { text: "hello", embedding: [0.1, 0.2] },
        { text: "world", embedding: [0.1, 0.2] },
      ],
    });
    expect(mocks.embedBatch).toHaveBeenCalledWith(["hello", "world"], { inputType: "document" });
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(1);
  });

  it("shows ordered embedding dimensions and bounded vector previews in text output", async () => {
    mocks.embedBatch.mockResolvedValueOnce([
      [0.1, -0.2],
      Array.from({ length: 1536 }, (_, index) => index + 1),
      [],
    ]);

    await runCapability("embedding", "create", "--text", "hello", "--text", "world", "--text", "");

    expect(mocks.runtime.log).toHaveBeenCalledWith(
      [
        "embedding.create via local",
        "provider: openai",
        "model: text-embedding-3-small",
        "outputs: 3",
        "hello",
        "dimensions: 2",
        "embedding: [0.1, -0.2]",
        "world",
        "dimensions: 1536",
        "embedding: [1, 2, 3, 4, 5, 6, 7, 8, ...]",
        "",
        "dimensions: 0",
        "embedding: []",
      ].join("\n"),
    );
  });

  it("retries embedding cleanup without masking the primary failure", async () => {
    closeEmbeddingProviderMock.mockRejectedValueOnce(new Error("close failed"));
    mocks.embedBatch.mockRejectedValueOnce(new Error("embedding failed"));
    await expect(runCapability("embedding", "create", "--text", "hello", "--json")).rejects.toThrow(
      "exit 1",
    );
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(2);
    expectRuntimeErrorContains("embedding failed");
  });

  it.each(["populated", "lock-failed"])(
    "logs out provider profiles when the store is %s",
    async (state) => {
      const store = {
        version: 1,
        profiles: {
          "openai:default": { id: "openai:default" },
          "openai:secondary": { id: "openai:secondary" },
          "anthropic:default": { id: "anthropic:default" },
        },
        order: { openai: ["openai:default", "openai:secondary"] },
        lastGood: { openai: "openai:secondary" },
        usageStats: {
          "openai:default": { errorCount: 2 },
          "openai:secondary": { errorCount: 1 },
          "anthropic:default": { errorCount: 3 },
        },
      };
      const profiles =
        state === "populated" ? ["openai:default", "openai:secondary"] : ["openai:default"];
      mocks.listProfilesForProvider.mockReturnValue(profiles);
      if (state === "populated") {
        mocks.loadAuthProfileStoreForRuntime.mockReturnValue(store as never);
        mocks.updateAuthProfileStoreWithLock.mockImplementationOnce(async ({ updater }) => {
          updater(store);
          return store;
        });
      } else if (state === "lock-failed") {
        mocks.updateAuthProfileStoreWithLock.mockResolvedValueOnce(null as never);
      }
      const run = runCapability("model", "auth", "logout", "--provider", "openai", "--json");
      if (state === "lock-failed") {
        await expect(run).rejects.toThrow("exit 1");
        expectRuntimeErrorContains("Failed to remove saved auth profiles for provider openai.");
        return;
      }
      await run;
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith({
        provider: "openai",
        removedProfiles: profiles,
      });
      if (state === "populated") {
        expect(store.profiles).toEqual({ "anthropic:default": { id: "anthropic:default" } });
        expect(store.order).toEqual({});
        expect(store.lastGood).toEqual({});
        expect(store.usageStats).toEqual({ "anthropic:default": { errorCount: 3 } });
        expect(mocks.updateAuthProfileStoreWithLock).toHaveBeenCalledWith(
          expect.objectContaining({ agentDir: "/tmp/agent-main" }),
        );
      }
    },
  );

  it.each([
    {
      position: "parent",
      action: "login",
      args: ["--provider", "openai"],
      expected: { provider: "openai", agent: "beta" },
    },
    {
      position: "leaf",
      action: "status",
      args: ["--json"],
      expected: { json: true, agent: "beta" },
    },
  ] as const)(
    "routes $position --agent through model auth $action",
    async ({ position, action, args, expected }) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });
      await runModelAuthWithAgent(position, action, "beta", ...args);
      const command = action === "login" ? mocks.modelsAuthLoginCommand : mocks.modelsStatusCommand;
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining(expected),
        action === "login" ? mocks.runtime : expect.any(Object),
      );
    },
  );

  it.each([
    { position: "parent" as const, agent: "", message: "--agent must not be blank" },
    { position: "leaf" as const, agent: "retired", message: 'Unknown agent id "retired"' },
  ])(
    "rejects invalid $position model auth agent '$agent' before dispatch",
    async ({ position, agent, message }) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { alpha: {}, beta: {} }, ownership: "explicit" },
      });

      await expect(runModelAuthWithAgent(position, "status", agent, "--json")).rejects.toThrow(
        "exit 1",
      );

      expectRuntimeErrorContains(message);
      expect(mocks.modelsStatusCommand).not.toHaveBeenCalled();
    },
  );

  it("marks env-backed image providers as configured", async () => {
    vi.stubEnv("FAL_KEY", "fal-test-key");
    mocks.getProviderEnvVarsCore.mockReturnValueOnce(["FAL_KEY"]);
    mocks.listRuntimeImageGenerationProviders.mockReturnValueOnce([
      { id: "fal", label: "fal", defaultModel: "fal-ai/flux", models: [] },
    ] as never);

    await runCap("capability", "image", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject([
      { id: "fal", available: true, configured: true, selected: false },
    ]);
  });

  it("marks env-backed video generation and description providers as configured", async () => {
    vi.stubEnv("RUNWAYML_API_SECRET", "runway-test-key");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    mocks.getProviderEnvVarsCore.mockImplementation((providerId: string) =>
      providerId === "runway" ? ["RUNWAYML_API_SECRET"] : ["GEMINI_API_KEY"],
    );
    mocks.listRuntimeVideoGenerationProviders.mockReturnValueOnce([
      { id: "runway", label: "Runway", defaultModel: "gen4", models: [] },
    ] as never);
    mocks.buildMediaUnderstandingRegistry.mockReturnValueOnce(
      new Map([
        [
          "google",
          {
            id: "google",
            capabilities: ["video"],
            defaultModels: { video: "gemini-3-flash-preview" },
          },
        ],
      ]),
    );

    await runCap("capability", "video", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject({
      generation: [{ id: "runway", configured: true }],
      description: [{ id: "google", configured: true }],
    });
  });

  it("marks env-backed TTS providers as configured", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    mocks.getProviderEnvVarsCore.mockReturnValueOnce(["XAI_API_KEY"]);
    mocks.listSpeechProviders.mockReturnValueOnce([
      { id: "xai", label: "xAI", models: [], voices: [] },
    ] as never);

    await runCap("capability", "tts", "providers", "--local", "--json");

    expect(firstJsonOutput()).toMatchObject({
      providers: [{ id: "xai", configured: true, selected: false }],
    });
  });

  it("distinguishes the local STT fallback winner from global provider selection", async () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "deepgram-test-key");
    mocks.buildMediaUnderstandingRegistry.mockReturnValueOnce(
      new Map([
        [
          "deepgram",
          {
            id: "deepgram",
            capabilities: ["audio"],
            defaultModels: { audio: "nova-3" },
          },
        ],
      ]),
    );
    const candidate = {
      id: "whisper-cli" as const,
      command: "whisper-cli",
      resolvedCommand: "/opt/homebrew/bin/whisper-cli",
      available: true,
      ready: true,
      capableBackend: "metal" as const,
      evidence: "Apple Silicon Homebrew whisper-cpp runtime with Metal support",
      selected: true,
      entry: {
        type: "cli" as const,
        command: "whisper-cli",
        args: ["{{MediaPath}}"],
      },
    };
    mocks.inspectLocalAudioSelection.mockResolvedValueOnce({
      candidates: [candidate],
      entries: [candidate.entry],
      selected: candidate,
    });

    await runCapability("audio", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject([
      { id: "deepgram", available: true, configured: true, selected: false },
      {
        id: "local/whisper-cli",
        available: true,
        configured: true,
        selected: false,
        localFallbackSelected: true,
        observedBackend: "unknown",
      },
    ]);
  });

  it("reports structured web search failures and exits nonzero", async () => {
    const provider = "kitchen-sink-search";
    const message = "Kitchen Sink rate limit.";
    const runtime = await import("../web-search/runtime.js");
    vi.mocked(runtime.runWebSearch).mockResolvedValueOnce({
      provider,
      result: {
        ok: false,
        statusCode: 429,
        error: { code: "rate_limited", message },
        results: [],
      },
    });
    await expect(
      runCap("capability", "web", "search", "--query", "rate limit", "--json"),
    ).rejects.toThrow("exit 1");
    expect(firstJsonOutput()).toEqual(
      expect.objectContaining({
        ok: false,
        capability: "web.search",
        provider,
        error: message,
      }),
    );
  });

  it.each([
    {
      action: "search",
      config: { tools: { web: { search: { provider: "exa", enabled: true } } } },
      args: ["--query", "ping", "--limit", "3"],
    },
    {
      action: "fetch",
      config: { tools: { web: { fetch: { enabled: true } } } },
      args: ["--url", "https://example.com", "--format", "text"],
    },
  ])(
    "resolves selected web $action provider SecretRefs before execution",
    async ({ action, config, args }) => {
      const resolvedConfig = { ...config, resolved: true };
      mocks.loadConfig.mockReturnValue(config);
      mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
        resolvedConfig,
        effectiveConfig: resolvedConfig,
        diagnostics: [],
      });
      const search = await import("../web-search/runtime.js");
      const fetch = await import("../web-fetch/runtime.js");
      const execute = vi.fn(async () => ({ content: "ok" }));
      if (action === "search") {
        vi.mocked(search.runWebSearch).mockResolvedValueOnce({
          provider: "firecrawl",
          result: { results: [] },
        });
      } else {
        vi.mocked(fetch.resolveWebFetchDefinition).mockReturnValueOnce({
          provider: { id: "firecrawl" },
          definition: { execute },
        } as never);
      }
      await runCap("infer", "web", action, ...args, "--provider", "firecrawl", "--json");
      const targets =
        action === "search"
          ? mocks.getCapabilityWebSearchCommandSecretTargets
          : mocks.getCapabilityWebFetchCommandSecretTargets;
      expect(targets).toHaveBeenCalledWith(config, { providerId: "firecrawl" });
      const resolution = mocks.resolveCommandConfigWithSecrets.mock.calls.at(-1)?.[0];
      expect(resolution).toMatchObject({
        commandName: `infer web ${action}`,
        targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
      });
      expect(resolution).not.toHaveProperty("allowedPaths");
      if (action === "search") {
        expect(search.runWebSearch).toHaveBeenCalledWith({
          config: resolvedConfig,
          providerId: "firecrawl",
          args: { query: "ping", count: 3, limit: 3 },
        });
      } else {
        expect(fetch.resolveWebFetchDefinition).toHaveBeenCalledWith({
          config: resolvedConfig,
          providerId: "firecrawl",
        });
        expect(execute).toHaveBeenCalledExactlyOnceWith({
          url: "https://example.com",
          extractMode: "text",
        });
      }
    },
  );

  it("includes selected custom generic embedding provider aliases", async () => {
    mocks.loadConfig.mockReturnValue({
      models: {
        providers: {
          "tenant-embeddings": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [],
          },
        },
      },
    });
    mocks.resolveMemorySearchConfig.mockReturnValue({
      provider: "tenant-embeddings",
      model: "text-embedding-bge-m3",
    } as never);
    mocks.listMemoryEmbeddingProviders.mockReturnValue([
      { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
    ]);
    mocks.listEmbeddingProviders.mockReturnValue([
      { id: "openai-compatible", transport: "remote" },
    ] as never);

    await runCapability("embedding", "providers", "--json");

    expect(firstJsonOutput()).toMatchObject([
      { id: "openai", configured: false, selected: false },
      { id: "openai-compatible", configured: false, selected: false },
      {
        id: "tenant-embeddings",
        configured: true,
        selected: true,
        defaultModel: "text-embedding-bge-m3",
        transport: "remote",
      },
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
