// Image tool tests cover model routing, provider auth, path safety, inbound
// media refs, data URLs, response validation, and compression policy.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { encodePngRgba, fillPixel } from "../../media/png-encode.js";
import type {
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../embedded-agent-runner/model.generation-scope.test-support.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import {
  createContainerWorkspaceSandboxFsBridge,
  createHostSandboxFsBridge,
} from "../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../test-helpers/unsafe-mounted-sandbox.js";
import { makeZeroUsageSnapshot } from "../usage.js";
import { createImageTool } from "./image-tool.js";
import {
  createMinimaxImageConfig,
  createImageTestConfig,
  makeImageModelDefinition,
  createImageWebMediaRuntime,
  createRequiredImageTool,
  executeImplicitImageTool,
  expectToolText,
  ONE_PIXEL_PNG_B64,
  resolveConfiguredImageModelForTest,
  testing,
  type ToolTextResult,
} from "./image-tool.test-support.js";
import { createPdfTool } from "./pdf-tool.js";

const publicSurfaceLoaderMocks = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: vi.fn(() => null),
}));

vi.mock("../../plugins/public-surface-loader.js", () => publicSurfaceLoaderMocks);

const imageProviderHarness = vi.hoisted(() => {
  let providers = new Map<string, MediaUnderstandingProvider>();
  return {
    setProviders(next: MediaUnderstandingProvider[]) {
      providers = new Map(next.map((provider) => [provider.id.toLowerCase(), provider]));
    },
    reset() {
      providers = new Map();
    },
    buildProviderRegistry(overrides?: Record<string, MediaUnderstandingProvider>) {
      const registry = new Map(providers);
      for (const [id, provider] of Object.entries(overrides ?? {})) {
        registry.set(id.toLowerCase(), provider);
      }
      return registry;
    },
    getMediaUnderstandingProvider(
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ): MediaUnderstandingProvider | undefined {
      return registry.get(id.toLowerCase()) ?? providers.get(id.toLowerCase());
    },
  };
});

// Keep image-tool tests focused on root propagation; media-tool-shared
// and channel-inbound tests cover the real bundled contract loader.
vi.mock("../../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRootsForChannel: (params: {
    cfg?: OpenClawConfig;
    channelId?: string | null;
    accountId?: string | null;
  }) => {
    const channelId = params.channelId?.trim();
    if (!channelId) {
      return undefined;
    }
    const channelConfig = params.cfg?.channels?.[channelId];
    const accountConfig = params.accountId
      ? channelConfig?.accounts?.[params.accountId]
      : undefined;
    const roots = [
      ...(accountConfig?.attachmentRoots ?? []),
      ...(channelConfig?.attachmentRoots ?? []),
    ];
    return channelId === "imessage" ? [...roots, "/Users/*/Library/Messages/Attachments"] : roots;
  },
}));

function readMockAuthProfileStore(agentDir?: string): AuthProfileStore {
  const fallback: AuthProfileStore = { version: 1, profiles: {} };
  if (!agentDir) {
    return fallback;
  }
  try {
    return JSON.parse(
      fsSync.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
  } catch {
    return fallback;
  }
}

function profilesForProvider(
  store: { profiles?: Record<string, { provider?: string }> },
  provider: string,
) {
  return Object.entries(store.profiles ?? {})
    .filter(([, profile]) => profile?.provider === provider)
    .map(([profileId]) => profileId);
}

function readMockRuntimeAuthProfileStore(agentDir?: string) {
  const store = readMockAuthProfileStore(agentDir);
  if (process.env.OPENCLAW_TEST_CODEX_CLI_OAUTH === "1") {
    store.profiles["openai:default"] = {
      provider: "openai",
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: 4_102_444_800_000,
    };
  }
  return store;
}

// mock-isolation: image selection uses fixture JSON profiles and simulated CLI credentials, never host auth state.
vi.mock("../auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: (params: { provider: string }) => params,
  ensureAuthProfileStore: readMockRuntimeAuthProfileStore,
  loadAuthProfileStoreForRuntime: readMockRuntimeAuthProfileStore,
  loadAuthProfileStoreForRuntimeAsync: async (agentDir?: string) =>
    readMockRuntimeAuthProfileStore(agentDir),
  ensureAuthProfileStoreWithoutExternalProfiles: readMockAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: async (agentDir?: string) =>
    readMockAuthProfileStore(agentDir),
  hasAnyAuthProfileStoreSource: (agentDir?: string) =>
    Boolean(agentDir && fsSync.existsSync(path.join(agentDir, "auth-profiles.json"))),
  listProfilesForProvider: profilesForProvider,
  resolveAuthProfileOrder: (params: {
    cfg?: OpenClawConfig;
    store: { profiles?: Record<string, { provider?: string }> };
    provider: string;
  }) => {
    const profiles = profilesForProvider(params.store, params.provider);
    const configured = params.cfg?.auth?.order?.[params.provider];
    return configured ? configured.filter((profileId) => profiles.includes(profileId)) : profiles;
  },
}));

vi.mock("../auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: (
    _store: unknown,
    options?: { providerIds?: Iterable<string> },
  ) => {
    const providerIds = new Set(
      Array.from(options?.providerIds ?? []).map((providerId) => providerId.toLowerCase()),
    );
    if (
      process.env.OPENCLAW_TEST_CODEX_CLI_OAUTH !== "1" ||
      (!providerIds.has("openai") && !providerIds.has("codex"))
    ) {
      return [];
    }
    return [
      {
        profileId: "openai:default",
        credential: {
          provider: "openai",
          type: "oauth",
          access: "oauth-test",
          refresh: "refresh-test",
          expires: Date.now() + 60_000,
        },
      },
    ];
  },
}));

vi.mock("../model-auth.js", () => ({
  resolveProviderEntryApiKeyProfileReference: (params: {
    cfg?: OpenClawConfig;
    provider: string;
    store: { profiles?: Record<string, { provider?: string; type?: string }> };
  }) => {
    const apiKey = params.cfg?.models?.providers?.[params.provider]?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return { kind: "none" };
    }
    const profile = params.store.profiles?.[apiKey.trim()];
    if (!profile) {
      return { kind: "literal", apiKey: apiKey.trim(), source: "models.json" };
    }
    return { kind: "profile", profileId: apiKey.trim(), credential: profile };
  },
  hasRuntimeAvailableProviderAuth: (params: {
    provider: string;
    cfg?: OpenClawConfig;
    modelApi?: string;
  }) => {
    const providerConfig = params.cfg?.models?.providers?.[params.provider];
    if (params.provider === "openai" && params.modelApi === "openai-responses") {
      return Boolean(process.env.OPENAI_API_KEY || providerConfig?.apiKey);
    }
    return Boolean(providerConfig?.apiKey);
  },
  hasUsableCustomProviderApiKey: (cfg?: OpenClawConfig, provider?: string) => {
    const providerConfig = cfg?.models?.providers?.[provider ?? ""];
    const apiKey = providerConfig?.apiKey;
    return typeof apiKey === "string" && apiKey.trim().length > 0;
  },
  resolveEnvApiKey: (provider: string) => {
    const envVarByProvider: Record<string, string[]> = {
      anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      minimax: ["MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN"],
      moonshot: ["MOONSHOT_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      opencode: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    };
    const envVar = (envVarByProvider[provider] ?? []).find((key) => {
      const value = process.env[key];
      return typeof value === "string" && value.length > 0;
    });
    return {
      apiKey: envVar ? process.env[envVar] : undefined,
      source: envVar ? "env" : undefined,
      envVar,
    };
  },
}));

const minimaxUnderstandImageMock = vi.hoisted(() => vi.fn());
vi.mock("../minimax-vlm.js", async () => {
  const mod = await vi.importActual<typeof import("../minimax-vlm.js")>("../minimax-vlm.js");
  return {
    ...mod,
    minimaxUnderstandImage: minimaxUnderstandImageMock,
  };
});

async function writeAuthProfiles(agentDir: string, profiles: unknown) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

function createLargeColorBlockPng(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4, 255);
  const centerStart = Math.floor(size * 0.25);
  const centerEnd = Math.floor(size * 0.75);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
      fillPixel(buf, x, y, size, inCenter ? 230 : 30, inCenter ? 40 : 110, inCenter ? 35 : 220);
    }
  }
  return encodePngRgba(buf, size, size);
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  // The tests inspect JPEG SOF markers directly so resize assertions do not
  // depend on an external decoder.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = expectDefined(buffer[offset + 1], "buffer[offset + 1] test invariant");
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions not found");
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG dimensions not found");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function registerImageToolEnvReset(priorFetch: typeof global.fetch, keys: string[]) {
  beforeEach(() => {
    for (const key of keys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });
}

function stubMinimaxOkFetch() {
  vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
  return stubMinimaxFetch({ status_code: 0, status_msg: "" });
}

function stubMinimaxFetch(baseResp: { status_code: number; status_msg: string }, content = "ok") {
  minimaxUnderstandImageMock.mockReset();
  if (baseResp.status_code !== 0) {
    minimaxUnderstandImageMock.mockRejectedValue(
      new Error(
        `MiniMax VLM API error (${baseResp.status_code})${
          baseResp.status_msg ? `: ${baseResp.status_msg}` : ""
        }.`,
      ),
    );
  } else {
    minimaxUnderstandImageMock.mockResolvedValue(content);
  }
  return minimaxUnderstandImageMock;
}

const minimaxProvider = {
  id: "minimax",
  capabilities: ["image"],
  describeImage: async (params: ImageDescriptionRequest) => ({
    text: await minimaxUnderstandImage({
      apiKey: process.env.MINIMAX_API_KEY ?? "",
      prompt: params.prompt ?? "Describe the image.",
      imageDataUrl: `data:${params.mime ?? "image/jpeg"};base64,${params.buffer.toString("base64")}`,
    }),
    model: "MiniMax-VL-01",
  }),
  describeImages: async (params: ImagesDescriptionRequest) => {
    const parts: string[] = [];
    for (const [index, image] of params.images.entries()) {
      const text = await minimaxUnderstandImage({
        apiKey: process.env.MINIMAX_API_KEY ?? "",
        prompt:
          params.images.length > 1
            ? `${params.prompt ?? "Describe the image."}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
            : (params.prompt ?? "Describe the image."),
        imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      });
      parts.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
    }
    return {
      text: parts.join("\n\n").trim(),
      model: "MiniMax-VL-01",
    };
  },
} satisfies MediaUnderstandingProvider;

async function unexpectedGenericImageDispatch(): Promise<never> {
  throw new Error("Expected a registered image provider or the implicit routing fixture");
}

const codexMediaProvider = {
  id: "codex",
  capabilities: ["image"],
  defaultModels: { image: "gpt-5.5" },
} satisfies MediaUnderstandingProvider;

const defaultImageModels = new Map<string, string>([
  ["anthropic", "claude-opus-4-6"],
  ["minimax", "MiniMax-VL-01"],
  ["minimax-cn", "MiniMax-VL-01"],
  ["minimax-portal", "MiniMax-VL-01"],
  ["minimax-portal-cn", "MiniMax-VL-01"],
  ["codex", "gpt-5.5"],
  ["openai", "gpt-5.4-mini"],
  ["opencode", "minimax-m3"],
  ["opencode-go", "kimi-k2.6"],
  ["zai", "glm-4.6v"],
]);

function installImageUnderstandingProviderDeps(
  providers: MediaUnderstandingProvider[],
  options?: Pick<
    NonNullable<Parameters<typeof testing.setProviderDepsForTest>[0]>,
    | "describeImageWithModel"
    | "describeImagesWithModel"
    | "loadImageWebMediaRuntime"
    | "resolveImageCompressionPolicy"
    | "resolveModelAsync"
    | "resolveAutoMediaKeyProviders"
    | "resolveDefaultMediaModel"
  > & { useDefaultResolveModelAsync?: boolean },
) {
  imageProviderHarness.setProviders(providers);

  testing.setProviderDepsForTest({
    buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
      imageProviderHarness.buildProviderRegistry(overrides),
    getMediaUnderstandingProvider: (
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
    describeImageWithModel: options?.describeImageWithModel ?? unexpectedGenericImageDispatch,
    describeImagesWithModel: options?.describeImagesWithModel ?? unexpectedGenericImageDispatch,
    resolveAutoMediaKeyProviders:
      options?.resolveAutoMediaKeyProviders ??
      (({ capability }) => (capability === "image" ? ["openai", "anthropic"] : [])),
    resolveDefaultMediaModel:
      options?.resolveDefaultMediaModel ??
      (({ providerId, capability }) =>
        capability === "image" ? defaultImageModels.get(providerId.toLowerCase()) : undefined),
    resolveRegisteredMediaUnderstandingProvider: ({ providerId }) =>
      imageProviderHarness.getMediaUnderstandingProvider(
        providerId,
        imageProviderHarness.buildProviderRegistry(),
      ),
    resolveModelAsync: options?.useDefaultResolveModelAsync
      ? undefined
      : (options?.resolveModelAsync ?? resolveConfiguredImageModelForTest),
    resolveImageCompressionPolicy: options?.resolveImageCompressionPolicy,
    loadImageWebMediaRuntime: options?.loadImageWebMediaRuntime,
  });
}

function installImageUnderstandingProviderStubs(...providers: MediaUnderstandingProvider[]) {
  installImageUnderstandingProviderDeps(providers);
}

function installFastLocalImageProviderStubs(...providers: MediaUnderstandingProvider[]) {
  installImageUnderstandingProviderDeps(providers, {
    describeImageWithModel: unexpectedGenericImageDispatch,
    describeImagesWithModel: unexpectedGenericImageDispatch,
    resolveImageCompressionPolicy: async ({ imageCount }) => ({ imageCount }),
    loadImageWebMediaRuntime: async () =>
      createImageWebMediaRuntime(async (mediaUrl, options) => {
        const { localRoots = [], inboundRoots = [], readFile } = options ?? {};
        if (
          localRoots !== "any" &&
          !isInboundPathAllowed({
            filePath: mediaUrl,
            roots: [...(localRoots ?? []), ...(inboundRoots ?? [])],
          })
        ) {
          throw new Error(`Local media path is not under an allowed directory: ${mediaUrl}`);
        }
        return {
          buffer: readFile ? await readFile(mediaUrl) : await fs.readFile(mediaUrl),
          contentType: "image/png",
          kind: "image",
          fileName: path.basename(mediaUrl),
        };
      }),
  });
}

function imageProvider(id: string, text = "ok") {
  return {
    id,
    capabilities: ["image"],
    describeImage: vi.fn(async (params: ImageDescriptionRequest) => ({
      text,
      model: params.model,
    })),
  } satisfies MediaUnderstandingProvider;
}

const inlineImage = `data:image/png;base64,${ONE_PIXEL_PNG_B64}`;
const describeImageArgs = { prompt: "Describe the image.", path: inlineImage };

async function expectImageToolExecOk(
  tool: {
    execute: (toolCallId: string, input: { prompt: string; path: string }) => Promise<unknown>;
  },
  imagePath: string,
) {
  const result = await tool.execute("t1", { ...describeImageArgs, path: imagePath });
  expectToolText(result, "ok");
  expect((result as ToolTextResult).details).toMatchObject({ text: "ok" });
}

function firstImageRequest(mock: { mock: { calls: unknown[][] } }): ImageDescriptionRequest {
  const request = mock.mock.calls.at(0)?.[0];
  if (!request) {
    throw new Error("expected describeImage call");
  }
  return request as ImageDescriptionRequest;
}

function fetchCallAt(mock: { mock: { calls: unknown[][] } }, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index + 1}`);
  }
  return call;
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let agentDir: string;

beforeEach(() => {
  agentDir = tempDirs.make("openclaw-image-");
});

function imageTool(
  config = createMinimaxImageConfig(),
  options: Omit<NonNullable<Parameters<typeof createImageTool>[0]>, "config" | "agentDir"> = {},
) {
  return createRequiredImageTool({ config, agentDir, ...options });
}

async function workspaceImage() {
  const workspaceDir = path.join(tempDirs.make("openclaw-workspace-image-"), "workspace");
  await fs.mkdir(workspaceDir);
  const imagePath = path.join(workspaceDir, "photo.png");
  await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
  return { workspaceDir, imagePath };
}

async function sandboxImage() {
  const sandboxRoot = path.join(agentDir, "sandbox");
  await fs.mkdir(sandboxRoot);
  return { sandboxRoot };
}

describe("image tool implicit imageModel config", () => {
  type Profiles = AuthProfileStore["profiles"];
  const openAiPrimaryCfg = createImageTestConfig({ model: { primary: "openai/gpt-5.4" } });

  const openAiOAuthProfile = (provider = "openai"): AuthProfileCredential => ({
    provider,
    type: "oauth" as const,
    access: "oauth-test",
    refresh: "refresh-test",
    expires: Date.now() + 60_000,
  });

  const makeAuthStore = (profiles: Profiles): AuthProfileStore => ({ version: 1, profiles });
  const writeProfiles = (directory: string, profiles: Profiles) =>
    writeAuthProfiles(directory, makeAuthStore(profiles));

  const priorFetch = global.fetch;
  registerImageToolEnvReset(priorFetch, [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "MINIMAX_API_KEY",
    "MODELSTUDIO_API_KEY",
    "QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    "OPENCLAW_TEST_CODEX_CLI_OAUTH",
    // Avoid implicit Copilot provider discovery hitting the network in tests.
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);

  beforeEach(() => {
    installImageUnderstandingProviderStubs(minimaxProvider);
  });

  afterEach(() => {
    imageProviderHarness.reset();
    testing.setProviderDepsForTest();
  });

  it.each([
    { name: "no auth", persisted: false, scoped: false, prepared: false, cli: false },
    { name: "no prepared provider", persisted: true, scoped: false, prepared: true, cli: false },
    { name: "external CLI OAuth", persisted: false, scoped: false, prepared: false, cli: true },
    { name: "scoped empty store", persisted: true, scoped: true, prepared: false, cli: false },
  ])(
    "resolves implicit OpenAI image auth with $name",
    async ({ persisted, scoped, prepared, cli }) => {
      if (persisted) {
        await writeProfiles(agentDir, { "openai:chatgpt": openAiOAuthProfile() });
      }
      if (persisted || cli) {
        installImageUnderstandingProviderStubs(minimaxProvider, codexMediaProvider);
      }
      if (cli) {
        vi.stubEnv("OPENCLAW_TEST_CODEX_CLI_OAUTH", "1");
      }
      const execution = executeImplicitImageTool({
        config: openAiPrimaryCfg,
        agentDir,
        ...(persisted || cli
          ? {
              authProfileStore: scoped
                ? makeAuthStore({})
                : readMockRuntimeAuthProfileStore(agentDir),
            }
          : {}),
        ...(prepared
          ? {
              preparedModelRuntime: {
                mediaCapabilityProviders: { mediaUnderstandingProviders: [] },
              } as never,
            }
          : {}),
      });
      if (cli) {
        expect((await execution).requests).toEqual(["codex/gpt-5.5"]);
      } else {
        await expect(execution).rejects.toThrow(/No image model is configured/);
      }
    },
  );

  it("pairs minimax-portal primary with MiniMax-VL-01 and fallbacks", async () => {
    const cfg = createImageTestConfig({ model: { primary: "minimax-portal/MiniMax-M2.7" } });
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    await writeProfiles(agentDir, {
      "minimax-portal:default": openAiOAuthProfile("minimax-portal"),
    });

    const { requests } = await executeImplicitImageTool(
      { config: cfg, agentDir, authProfileStore: readMockRuntimeAuthProfileStore(agentDir) },
      2,
    );
    expect(requests).toEqual([
      "minimax-portal/MiniMax-VL-01",
      "openai/gpt-5.4-mini",
      "anthropic/claude-opus-4-6",
    ]);
  });

  it("defers implicit image model discovery during hot-path tool registration", async () => {
    const resolveDefaultMediaModelSpy = vi.fn(() => "gpt-5.4-mini");
    const resolveAutoMediaKeyProvidersSpy = vi.fn(() => ["openai"]);
    installImageUnderstandingProviderDeps([minimaxProvider], {
      resolveDefaultMediaModel: resolveDefaultMediaModelSpy,
      resolveAutoMediaKeyProviders: resolveAutoMediaKeyProvidersSpy,
    });
    const cfg = createImageTestConfig({ model: { primary: "openai/gpt-5.4" } });

    const tool = createImageTool({
      config: cfg,
      agentDir,
    });

    expect(typeof tool?.execute).toBe("function");
    expect(resolveDefaultMediaModelSpy).not.toHaveBeenCalled();
    expect(resolveAutoMediaKeyProvidersSpy).not.toHaveBeenCalled();
  });

  it("honors a per-call model override when no imageModel is configured", async () => {
    const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
      text: `ok ${params.provider}/${params.model}`,
      model: params.model,
    }));
    installFastLocalImageProviderStubs({
      id: "opencode-go",
      capabilities: ["image"],
      describeImage,
    });
    const cfg = createImageTestConfig({ model: { primary: "opencode-go/kimi-k2.6" } });
    const tool = imageTool(cfg);

    const result = await tool.execute("t1", {
      prompt: "Describe this image.",
      path: inlineImage,
      model: "opencode-go/mimo-v2.5",
    });

    const request = firstImageRequest(describeImage);
    expect(request).toMatchObject({ provider: "opencode-go", model: "mimo-v2.5" });
    expectToolText(result, "ok opencode-go/mimo-v2.5");
  });

  it("carries the scoped auth store into image provider execution", async () => {
    const provider = imageProvider("codex");
    const { describeImage } = provider;
    installImageUnderstandingProviderStubs(provider);
    const authProfileStore = makeAuthStore({
      "openai:scoped": openAiOAuthProfile(),
    });
    const tool = imageTool(createImageTestConfig({ imageModel: { primary: "codex/gpt-5.5" } }), {
      authProfileStore,
    });

    await tool.execute("t1", {
      prompt: "Describe this image.",
      path: inlineImage,
    });

    expect(firstImageRequest(describeImage).authStore).toBe(authProfileStore);
  });

  it.each([
    { name: "ignores chat metadata", primary: true, cnCandidate: true, auto: false },
    { name: "prefers the configured CN alias", primary: false, cnCandidate: true, auto: true },
    { name: "retains the canonical fallback", primary: false, cnCandidate: false, auto: true },
  ])("routes MiniMax image models: $name", async ({ primary, cnCandidate, auto }) => {
    if (auto) {
      installImageUnderstandingProviderDeps([minimaxProvider], {
        resolveAutoMediaKeyProviders: ({ capability }) =>
          capability === "image"
            ? cnCandidate
              ? ["openai", "anthropic", "minimax-cn", "minimax"]
              : ["minimax"]
            : [],
        resolveDefaultMediaModel: ({ providerId, capability }) =>
          capability === "image" && (cnCandidate || providerId === "minimax")
            ? defaultImageModels.get(providerId.toLowerCase())
            : undefined,
      });
    }
    const cfg: OpenClawConfig = {
      ...(primary
        ? { agents: { defaults: { model: { primary: "minimax-cn/MiniMax-M2.5" } } } }
        : {}),
      models: {
        mode: "merge",
        providers: {
          "minimax-cn": {
            baseUrl: "https://api.minimaxi.com/anthropic",
            apiKey: "${MINIMAX_API_KEY}",
            api: "anthropic-messages",
            models: cnCandidate ? [makeImageModelDefinition("MiniMax-M2.5")] : [],
          },
        },
      },
    };
    const authStore = {
      version: 1,
      profiles: {
        ...(cnCandidate ? { mini: createApiKeyCredential("minimax-cn", "minimax-test") } : {}),
        miniGlobal: { type: "api_key", provider: "minimax", key: "minimax-test" },
      },
    } as const;

    const { requests } = await executeImplicitImageTool({
      config: cfg,
      agentDir,
      authProfileStore: authStore,
    });
    expect(requests).toEqual([`${cnCandidate ? "minimax-cn" : "minimax"}/MiniMax-VL-01`]);
  });

  it.each([
    { name: "capability timeout", modelTimeout: undefined, expected: 180_000 },
    { name: "matching model timeout", modelTimeout: 300, expected: 300_000 },
  ])("uses $name for provider calls", async ({ modelTimeout, expected }) => {
    const { workspaceDir, imagePath } = await workspaceImage();
    const provider = imageProvider("ollama");
    const { describeImage } = provider;
    installFastLocalImageProviderStubs(provider);
    const model = "gemma4:26b-a4b-it-q4_K_M";
    const cfg: OpenClawConfig = {
      agents: { defaults: { imageModel: { primary: `ollama/${model}` } } },
      tools: {
        media: {
          image: { timeoutSeconds: 180 },
          ...(modelTimeout === undefined
            ? {}
            : {
                models: [
                  {
                    provider: "ollama",
                    model,
                    timeoutSeconds: modelTimeout,
                    capabilities: ["image"],
                  },
                ],
              }),
        },
      },
    };
    const tool = imageTool(cfg, { workspaceDir });
    await expectImageToolExecOk(tool, imagePath);
    expect(firstImageRequest(describeImage).timeoutMs).toBe(expected);
  });

  it.each([
    ["acme", "acme", false, true],
    ["kimchi", "kimchi", true, false],
    ["amazon-bedrock", "aws-bedrock", false, false],
  ] as const)(
    "pairs configured image models for %s with chat provider %s",
    async (provider, chatProvider, prefixed, checkTool) => {
      const model = "vision-1";
      const authProfileStore = createAuthProfileStoreFixture({
        [`${provider}:default`]: createApiKeyCredential(provider, "sk-test"),
      });
      await writeAuthProfiles(agentDir, authProfileStore);
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: `${chatProvider}/text-1` } } },
        models: {
          providers: {
            [provider]: {
              baseUrl: "https://example.com",
              models: [
                makeImageModelDefinition(prefixed ? `${provider}/text-1` : "text-1", ["text"]),
                makeImageModelDefinition(prefixed ? `${provider}/${model}` : model),
              ],
            },
          },
        },
      };
      const execution = executeImplicitImageTool({
        config: cfg,
        agentDir,
        authProfileStore,
      });
      if (provider !== chatProvider) {
        await expect(execution).rejects.toThrow(/No image model is configured/);
      } else {
        expect((await execution).requests).toEqual([`${provider}/${model}`]);
      }
      if (checkTool) {
        // Direct image factories retain their shipped directory-backed auth contract.
        expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
        expect(typeof createPdfTool({ config: cfg, agentDir })?.execute).toBe("function");
      }
    },
  );

  it.each<{
    name: string;
    imageModel: { primary: string; fallbacks?: string[] };
    providers?: string[];
    models?: string[];
    expected: string | RegExp;
  }>([
    {
      name: "ambiguous providerless model",
      imageModel: { primary: "moondream" },
      providers: ["ollama", "lmstudio"],
      models: ["moondream"],
      expected: /Ambiguous image model "moondream"/,
    },
    {
      name: "unmatched providerless model on default provider path",
      imageModel: { primary: "gpt-5.4-mini" },
      expected: "openai/gpt-5.4-mini",
    },
  ])("resolves $name", async ({ imageModel, providers, models, expected }) => {
    const cfg: OpenClawConfig = {
      ...createImageTestConfig({ imageModel }),
      ...(providers
        ? {
            models: {
              providers: Object.fromEntries(
                providers.map((provider) => [
                  provider,
                  {
                    baseUrl:
                      provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234",
                    models: (models ?? []).map((model) => makeImageModelDefinition(model)),
                  },
                ]),
              ),
            },
          }
        : {}),
    };
    const execution = executeImplicitImageTool({
      config: cfg,
      agentDir,
      authProfileStore: readMockRuntimeAuthProfileStore(agentDir),
    });
    if (expected instanceof RegExp) {
      await expect(execution).rejects.toThrow(expected);
    } else {
      expect((await execution).requests).toEqual([expected]);
    }
  });

  it("loads images directly for native-vision models without resolving an image model", async () => {
    const cfg = createImageTestConfig(
      {
        model: { primary: "acme/vision-1" },
        imageModel: { primary: "moondream" },
        imageMaxDimensionPx: 32,
      },
      {
        acme: { baseUrl: "https://example.com", models: [makeImageModelDefinition("vision-1")] },
        ollama: {
          baseUrl: "http://localhost:11434",
          models: [makeImageModelDefinition("moondream")],
        },
        lmstudio: {
          baseUrl: "http://localhost:1234",
          models: [makeImageModelDefinition("moondream")],
        },
      },
    );
    const describeImageWithModel = vi.fn(async () => {
      throw new Error("native image loading must not call a fallback model");
    });
    const describeImagesWithModel = vi.fn(async () => {
      throw new Error("native image loading must not call a fallback model");
    });
    testing.setProviderDepsForTest({ describeImageWithModel, describeImagesWithModel });

    const tool = imageTool(cfg, { modelHasVision: true });
    expect(tool).toMatchObject({
      name: "view_image",
      label: "View Image",
      catalogMode: "direct-only",
    });
    expect(tool.description).toContain("private model context");
    expect(tool.description).toContain("Does not display, attach, or send");

    const result = await tool.execute("native-image", {
      prompt: "Read the screenshot error.",
      path: inlineImage,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Loaded 1 image into private model context for inspection; not displayed, attached, or sent to the user.",
      },
      expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
    ]);
    expect(result.details).toMatchObject({
      transport: "native",
      media: { outbound: false },
    });
    expect(describeImageWithModel).not.toHaveBeenCalled();
    expect(describeImagesWithModel).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "omits undecodable JPEGs (readable batch member: %s)",
    async (includeValid) => {
      const jpeg = await fs.readFile("test/fixtures/media/roof-camera-sky.jpg");
      const corruptPath = path.join(agentDir, "truncated.jpg");
      const validPath = path.join(agentDir, "valid.jpg");
      await fs.writeFile(corruptPath, jpeg.subarray(0, 65536));
      await fs.writeFile(validPath, jpeg);
      const tool = createRequiredImageTool({
        agentDir,
        workspaceDir: agentDir,
        modelHasVision: true,
        config: { agents: { defaults: { imageMaxDimensionPx: 2048 } } },
      });
      const result = await tool.execute("corrupt-image", {
        paths: includeValid ? [corruptPath, validPath] : [corruptPath],
      });
      expect(result.content.filter((block) => block.type === "image")).toEqual(
        includeValid
          ? [{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }]
          : [],
      );
      expect(result.details).toMatchObject(includeValid ? { image: validPath } : { images: [] });
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(includeValid ? /^Loaded 1 image\b/ : /^Loaded 0 images\b/),
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: expect.stringMatching(/omitted.*decode/i),
      });
    },
  );

  it("does not accept the legacy image argument", async () => {
    const tool = imageTool();
    await expect(
      tool.execute("legacy-image-arg", {
        image: inlineImage,
      }),
    ).rejects.toThrow("path required");
  });

  it("preserves the unsupported image reference result contract", async () => {
    const tool = imageTool();
    const result = await tool.execute("unsupported-image-reference", {
      path: "ftp://example.test/image.png",
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Unsupported image reference") }],
      details: {
        error: "unsupported_image_reference",
        path: "ftp://example.test/image.png",
      },
    });
  });

  it.each([undefined, true])(
    "enforces local image roots (workspaceOnly: %s)",
    async (workspaceOnly) => {
      const { workspaceDir, imagePath } = await workspaceImage();
      const fetch = stubMinimaxOkFetch();
      const cfg = createMinimaxImageConfig();
      const tool = imageTool(cfg, {
        ...(workspaceOnly === true ? { workspaceDir } : {}),
        ...(workspaceOnly === undefined ? {} : { fsPolicy: { workspaceOnly } }),
      });
      let deniedPath = imagePath;
      if (workspaceOnly === true) {
        await expectImageToolExecOk(tool, imagePath);
        expect(fetch).toHaveBeenCalledTimes(1);
        deniedPath = path.join(path.dirname(workspaceDir), "secret.png");
        await fs.writeFile(deniedPath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
      }
      await expect(
        tool.execute("denied", { prompt: "Describe.", path: deniedPath }),
      ).rejects.toThrow(/not under an allowed directory/i);
      if (workspaceOnly === undefined) {
        const withWorkspace = imageTool(cfg, { workspaceDir });
        await expectImageToolExecOk(withWorkspace, imagePath);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("allows current iMessage account attachments", async () => {
    const provider = imageProvider("ollama");
    const { describeImage } = provider;
    installFastLocalImageProviderStubs(provider);
    const attachmentRoot = tempDirs.make("openclaw-imessage-root-");
    const imagePath = path.join(attachmentRoot, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    const cfg: OpenClawConfig = {
      agents: { defaults: { imageModel: { primary: "ollama/moondream" } } },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            models: [makeImageModelDefinition("moondream")],
          },
        },
      },
      channels: {
        imessage: {
          accounts: {
            work: {
              attachmentRoots: [attachmentRoot],
            },
          },
        },
      },
    };
    const withoutChannel = imageTool(cfg);
    await expect(
      withoutChannel.execute("t1", { prompt: "Describe.", path: imagePath }),
    ).rejects.toThrow(/not under an allowed directory/i);
    const withImessage = imageTool(cfg, {
      agentChannel: "imessage",
      agentAccountId: "work",
    });
    await expectImageToolExecOk(withImessage, imagePath);
    expect(describeImage).toHaveBeenCalledTimes(1);
  });

  it("passes web_fetch SSRF policy to remote image references", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("http://198.18.0.153/")) {
        return new Response(Buffer.from(ONE_PIXEL_PNG_B64, "base64"), {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response(
        JSON.stringify({ content: "ok", base_resp: { status_code: 0, status_msg: "" } }),
      );
    });
    global.fetch = withFetchPreconnect(fetch);
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");

    const cfg: OpenClawConfig = {
      ...createMinimaxImageConfig(),
      tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
    };
    const tool = imageTool(cfg);

    await expectImageToolExecOk(tool, "http://198.18.0.153/reference.png");
    const [input, init] = fetchCallAt(fetch, 0);
    expect(input).toBe("http://198.18.0.153/reference.png");
    expect(typeof init).toBe("object");
  });

  it("sandboxes image paths like the read tool", async () => {
    const { sandboxRoot } = await sandboxImage();
    await fs.writeFile(path.join(sandboxRoot, "img.png"), "fake", "utf8");
    const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };

    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = createImageTestConfig({ model: { primary: "minimax/MiniMax-M2.7" } });
    const tool = imageTool(cfg, { sandbox });

    await expect(tool.execute("t1", { path: "https://example.com/a.png" })).rejects.toThrow(
      /Sandboxed view_image does not allow remote URLs/i,
    );

    await expect(tool.execute("t2", { path: "../escape.png" })).rejects.toThrow(
      /escapes sandbox root/i,
    );
  });

  it("reads a mounted image from FILE:/workspace/img.png", async () => {
    const { sandboxRoot } = await sandboxImage();
    await fs.writeFile(path.join(sandboxRoot, "img.png"), Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    const bridge = createContainerWorkspaceSandboxFsBridge(sandboxRoot);
    stubMinimaxOkFetch();
    const tool = createRequiredImageTool({
      config: createMinimaxImageConfig(),
      agentDir,
      workspaceDir: sandboxRoot,
      sandbox: { root: sandboxRoot, bridge },
      fsPolicy: { workspaceOnly: true },
    });

    await expectImageToolExecOk(tool, "FILE:/workspace/img.png");
  });

  it("applies workspace-only policy to image paths in sandbox mode", async () => {
    const { sandboxRoot } = await sandboxImage();
    await fs.writeFile(path.join(agentDir, "secret.png"), Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot: agentDir });
    const bridge = sandbox.fsBridge;
    if (!bridge) {
      throw new Error("expected unsafe sandbox filesystem bridge");
    }
    const fetch = stubMinimaxOkFetch();
    const tool = createRequiredImageTool({
      config: createMinimaxImageConfig(),
      agentDir,
      workspaceDir: sandboxRoot,
      sandbox: { root: sandboxRoot, bridge },
      fsPolicy: { workspaceOnly: true },
    });
    await expect(
      tool.execute("t1", {
        prompt: "Describe the image.",
        path: "/agent/secret.png",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    const { sandboxRoot } = await sandboxImage();
    await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(sandboxRoot, "media", "inbound", "photo.png"),
      Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
    );

    const fetch = stubMinimaxOkFetch();

    const cfg = createMinimaxImageConfig();
    const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
    const tool = imageTool(cfg, { sandbox });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      path: "@/Users/steipete/.openclaw/media/inbound/photo.png",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.details).toMatchObject({ rewrittenFrom: expect.stringContaining("photo.png") });
  });

  it("resolves a producer-staged bare upload handle", async () => {
    const { sandboxRoot } = await sandboxImage();
    const stagedPath = "media/inbound/openclaw-staged-proof/input-file_upload.png";
    await fs.mkdir(path.dirname(path.join(sandboxRoot, stagedPath)), { recursive: true });
    await fs.writeFile(
      path.join(sandboxRoot, stagedPath),
      Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
    );

    const fetch = stubMinimaxOkFetch();
    const sandbox = {
      root: sandboxRoot,
      bridge: createHostSandboxFsBridge(sandboxRoot),
      stagedMediaPaths: new Map([["file_upload", stagedPath]]),
    };
    const tool = createRequiredImageTool({
      config: createMinimaxImageConfig(),
      agentDir,
      sandbox,
    });

    const res = await tool.execute("t1", { path: "file_upload" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.details).toMatchObject({ rewrittenFrom: "file_upload" });

    await fs.writeFile(
      path.join(sandboxRoot, "file_upload"),
      Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
    );
    const direct = await tool.execute("t2", { path: "file_upload" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(direct.details).not.toHaveProperty("rewrittenFrom");
  });
});

describe("image tool data URL support", () => {
  it.each([
    {
      dataUrl: "data:text/plain;base64,SGVsbG8=",
      maxBytes: undefined,
      error: /Unsupported data URL type/i,
    },
    { dataUrl: `data:image/png;base64,${"A".repeat(16)}`, maxBytes: 4, error: /size limit/i },
  ])("rejects invalid data URLs before decoding: $error", ({ dataUrl, maxBytes, error }) => {
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => testing.decodeDataUrl(dataUrl, { maxBytes })).toThrow(error);
      expect(bufferFromSpy).not.toHaveBeenCalledWith(dataUrl.split(",")[1], "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});

describe("image tool MiniMax VLM routing", () => {
  const priorFetch = global.fetch;
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "minimax-vlm", applyEnv: false });
    installImageUnderstandingProviderStubs(minimaxProvider);
  });

  afterEach(async () => {
    global.fetch = priorFetch;
    imageProviderHarness.reset();
    testing.setProviderDepsForTest();
    await state.cleanup();
  });

  async function createMinimaxVlmFixture(baseResp: { status_code: number; status_msg: string }) {
    const fetchMock = stubMinimaxFetch(baseResp, baseResp.status_code === 0 ? "ok" : "");

    const fixtureAgentDir = state.agentDir();
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = createMinimaxImageConfig();
    const tool = createRequiredImageTool({ config: cfg, agentDir: fixtureAgentDir });
    return { fetch: fetchMock, tool, cfg, agentDir: fixtureAgentDir };
  }

  it("combines path + paths with dedupe and enforces maxImages", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });
    const secondPngB64 = createLargeColorBlockPng(2).toString("base64");

    const deduped = await tool.execute("t1", {
      prompt: "Compare these images.",
      maxImages: "2",
      maxBytesMb: "1",
      path: inlineImage,
      paths: [
        inlineImage,
        `data:image/png;base64,${secondPngB64}`,
        `data:image/png;base64,${secondPngB64}`,
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(deduped.details).toMatchObject({ images: [expect.anything(), expect.anything()] });

    const tooMany = await tool.execute("t2", {
      prompt: "Compare these images.",
      path: inlineImage,
      paths: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tooMany.details).toMatchObject({ error: "too_many_images", count: 2, max: 1 });
  });

  it.each([
    { args: { maxImages: 1.5 }, error: "maxImages must be a positive integer" },
    { args: { maxBytesMb: 0 }, error: "maxBytesMb must be greater than 0" },
  ])("rejects invalid image caps before loading: $error", async ({ args, error }) => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });
    await expect(
      tool.execute("invalid-cap", {
        ...describeImageArgs,
        prompt: "Compare these images.",
        ...args,
      }),
    ).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces MiniMax API errors from /v1/coding_plan/vlm", async () => {
    const {
      tool,
      cfg,
      agentDir: fixtureAgentDir,
    } = await createMinimaxVlmFixture({
      status_code: 1004,
      status_msg: "bad key",
    });
    const generation = createModelGenerationFixture({
      agentDir: fixtureAgentDir,
      workspaceDir: state.workspaceDir,
      config: cfg,
      label: "minimax-vlm",
      provider: "minimax",
      requestProvider: "minimax",
    });
    const classifyFailoverReason = vi.fn(() => undefined);
    expectDefined(
      generation.pluginRegistry.providers[0],
      "MiniMax provider registration",
    ).provider.classifyFailoverReason = classifyFailoverReason;

    // Embedded tools inherit this registry scope before provider error classification.
    await expect(
      withPluginRuntimeGenerationScope(generation.preparedModelRuntime, () =>
        tool.execute("t1", describeImageArgs),
      ),
    ).rejects.toThrow(/MiniMax VLM API error/i);
    expect(classifyFailoverReason).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax",
        errorMessage: "MiniMax VLM API error (1004): bad key.",
      }),
    );
  });
});

describe("image tool response validation", () => {
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
    "detects image reasoning-only responses: %s",
    (_name, signature, expected, precedingBlocks) => {
      const message = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4-mini",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: makeZeroUsageSnapshot(),
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
      };
      expect(testing.hasImageReasoningOnlyResponse(message as never)).toBe(expected);
    },
  );
});

describe("image compression policy", () => {
  function metadataModel(
    id: string,
    name: string,
    maxSidePx: number,
    preferredSidePx = maxSidePx,
    tokenMode: "provider" | "detail" = "provider",
  ): ModelDefinitionConfig {
    const openai = tokenMode === "detail";
    return {
      ...makeImageModelDefinition(id),
      name,
      reasoning: true,
      contextWindow: openai ? 272_000 : 1_000_000,
      maxTokens: openai ? 128_000 : 64_000,
      mediaInput: { image: { maxSidePx, preferredSidePx, tokenMode } },
    };
  }

  const cfgWithImageModelMetadata = {
    agents: { defaults: { imageQuality: "high" } },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [
            metadataModel("claude-opus-4-7", "Claude Opus 4.7", 2576),
            metadataModel("claude-opus-4-6", "Claude Opus 4.6", 1568),
          ],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [metadataModel("gpt-5.5", "GPT-5.5", 6000, 2048, "detail")],
        },
      },
    },
  } satisfies OpenClawConfig;

  beforeEach(() => {
    installImageUnderstandingProviderStubs();
  });

  afterEach(() => {
    imageProviderHarness.reset();
    testing.setProviderDepsForTest();
  });

  it("keeps image policy pinned to the prepared generation: static catalog", async () => {
    const state = await createOpenClawTestState({ label: "image-model-generation" });
    try {
      const provider = "prepared-image-provider";
      const model = "prepared-image-model";
      const cfg = {} satisfies OpenClawConfig;
      const generationA = createModelGenerationFixture({
        agentDir: state.agentDir("prepared"),
        workspaceDir: state.workspaceDir,
        config: cfg,
        label: "image-a",
        provider,
        requestProvider: provider,
        modelId: model,
        runtimeAugment: false,
        staticImagePolicy: {
          maxBytes: 1_000_000,
          preferredSidePx: 1_280,
          tokenMode: "detail",
        },
        runtimeImagePolicy: { maxSidePx: 1_440 },
      });
      const generationB = createModelGenerationFixture({
        agentDir: state.agentDir("prepared"),
        workspaceDir: state.workspaceDir,
        config: cfg,
        label: "image-b",
        provider,
        requestProvider: provider,
        modelId: model,
        runtimeAugment: false,
        staticImagePolicy: {
          maxBytes: 2_000_000,
          preferredSidePx: 2_560,
          tokenMode: "provider",
        },
        runtimeImagePolicy: { maxSidePx: 2_880 },
      });
      installImageUnderstandingProviderDeps([], {
        useDefaultResolveModelAsync: true,
      });
      publishCurrentModelGeneration(generationB);

      // Compression deliberately omits agentDir: real resolution uses the default
      // agent, not the distinct "prepared" agent stored in the snapshot.
      await expect(
        testing.resolveImageCompressionPolicy({
          cfg,
          imageModelConfig: { primary: `${provider}/${model}` },
          imageCount: 1,
          preparedModelRuntime: generationA.preparedModelRuntime,
          workspaceDir: generationA.preparedModelRuntime.workspaceDir,
        }),
      ).resolves.toEqual({
        imageCount: 1,
        models: [
          {
            maxSidePx: 1_440,
            maxBytes: 1_000_000,
            preferredSidePx: 1_280,
            tokenMode: "detail",
          },
        ],
      });
      expect(generationA.resolveDynamicModel).toHaveBeenCalledTimes(1);
      expect(generationB.resolveDynamicModel).not.toHaveBeenCalled();
    } finally {
      resetModelGenerationFixtureState();
      await state.cleanup();
    }
  });

  it.each([
    { route: "override", supplied: "captured", expected: "captured", maxSidePx: 96 },
    { route: "fallback", supplied: "captured", expected: "captured", maxSidePx: 96 },
    { route: "primary", supplied: "none", expected: "ambient", maxSidePx: 192 },
  ])(
    "uses $supplied metadata for $route image selection and compression",
    async ({ route, supplied, expected, maxSidePx }) => {
      const state = await createOpenClawTestState({ label: "image-captured-planning" });
      try {
        const provider = "image-planning";
        const cfg = {
          agents: {
            defaults: {
              imageQuality: "high",
              imageModel: {
                primary: `${provider}/${route === "fallback" ? "unavailable" : "entry"}`,
                ...(route === "fallback" ? { fallbacks: [`${provider}/entry`] } : {}),
              },
            },
          },
          models: {
            providers: {
              [provider]: {
                api: "openai-completions",
                baseUrl: "https://image-planning.example.test/v1",
                models: [
                  { id: "captured", side: 96 },
                  { id: "ambient", side: 192 },
                  { id: "unavailable", side: 256 },
                ].map(({ id, side }) =>
                  Object.assign(makeImageModelDefinition(id), {
                    mediaInput: { image: { maxSidePx: side, preferredSidePx: side } },
                  }),
                ),
              },
            },
          },
        } satisfies OpenClawConfig;
        const generation = (modelId: string) => {
          const fixture = createModelGenerationFixture({
            agentDir: state.agentDir("image"),
            workspaceDir: state.workspaceDir,
            config: cfg,
            label: modelId,
            provider,
            requestProvider: provider,
            modelId,
          });
          const metadataSnapshot = createPluginMetadataSnapshot({
            config: cfg,
            workspaceDir: state.workspaceDir,
            manifestRegistry: {
              plugins: fixture.metadataSnapshot.plugins.map((plugin) => ({
                ...plugin,
                modelIdNormalization: {
                  providers: { [provider]: { aliases: { entry: modelId } } },
                },
              })),
              diagnostics: [],
            },
          });
          metadataSnapshot.owners.modelIdNormalizationPolicies =
            collectManifestModelIdNormalizationPolicies(metadataSnapshot.plugins);
          return {
            ...fixture,
            metadataSnapshot,
            preparedModelRuntime: { ...fixture.preparedModelRuntime, metadataSnapshot },
          };
        };
        const captured = generation("captured");
        const ambient = generation("ambient");
        publishCurrentModelGeneration(ambient);
        const observed: Array<{ model: string; width: number; height: number }> = [];
        installImageUnderstandingProviderDeps(
          [
            {
              id: provider,
              capabilities: ["image"],
              describeImage: async (request) => {
                const dimensions =
                  request.mime === "image/png"
                    ? readPngDimensions(request.buffer)
                    : readJpegDimensions(request.buffer);
                observed.push({ model: request.model, ...dimensions });
                if (request.model === "unavailable") {
                  throw new Error("fixture image model unavailable");
                }
                return { text: "inspected", model: request.model };
              },
            },
          ],
          { useDefaultResolveModelAsync: true },
        );
        const tool = createRequiredImageTool({
          config: cfg,
          agentDir: state.agentDir("image"),
          workspaceDir: state.workspaceDir,
          ...(supplied === "none"
            ? {}
            : {
                preparedModelRuntime: (supplied === "captured" ? captured : ambient)
                  .preparedModelRuntime,
              }),
        });
        const source = createLargeColorBlockPng(256);
        const result = await withPluginRuntimeGenerationScope(ambient.preparedModelRuntime, () =>
          tool.execute("image", {
            path: `data:image/png;base64,${source.toString("base64")}`,
            ...(route === "override" ? { model: `${provider}/entry` } : {}),
          }),
        );
        expect.soft(result.details).toMatchObject({ model: `${provider}/${expected}` });
        expect
          .soft(observed.map(({ model }) => model))
          .toEqual(route === "fallback" ? ["unavailable", expected] : [expected]);
        expect.soft(observed.at(-1)).toMatchObject({ width: maxSidePx, height: maxSidePx });
      } finally {
        resetModelGenerationFixtureState();
        await state.cleanup();
      }
    },
  );

  it("resolves compression metadata for a providerless model override", async () => {
    await expect(
      testing.resolveImageCompressionPolicy({
        cfg: cfgWithImageModelMetadata,
        imageModelConfig: { primary: "anthropic/claude-opus-4-6" },
        modelOverride: "gpt-5.5",
        imageCount: 1,
      }),
    ).resolves.toMatchObject({
      models: [{ maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" }],
    });
  });

  it("uses bundled Anthropic media limits and handles unknown fallback models", async () => {
    installImageUnderstandingProviderDeps([], { useDefaultResolveModelAsync: true });
    await expect(
      testing.resolveImageCompressionPolicy({
        cfg: {},
        imageModelConfig: {
          primary: "anthropic/claude-opus-4-8",
          fallbacks: ["anthropic/claude-haiku-4-5", "unknown/custom-image"],
        },
        imageCount: 1,
      }),
    ).resolves.toEqual({
      imageCount: 1,
      models: [
        { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
        { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
        {},
      ],
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
