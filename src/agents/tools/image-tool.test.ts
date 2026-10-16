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
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { AssistantMessage } from "../../llm/types.js";
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
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  createContainerWorkspaceSandboxFsBridge,
  createHostSandboxFsBridge,
} from "../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../test-helpers/unsafe-mounted-sandbox.js";
import { createImageTool } from "./image-tool.js";
import {
  createMinimaxImageConfig,
  createImageToolForTest as createRequiredImageTool,
  createImageWebMediaRuntime,
  makeModelDefinition,
  ONE_PIXEL_PNG_B64,
  resolveConfiguredImageModelForTest,
  resolveImageModelConfigForTool,
  testing,
} from "./image-tool.test-support.js";
import { createPdfTool } from "./pdf-tool.js";

const publicSurfaceLoaderMocks = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: vi.fn(() => null),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(
    ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
      if (dirName === "imessage" && artifactBasename === "media-contract-api.js") {
        return {
          resolveInboundAttachmentRoots: ({
            accountId,
            cfg,
          }: {
            accountId?: string | null;
            cfg: OpenClawConfig;
          }) => [
            ...((accountId
              ? cfg.channels?.imessage?.accounts?.[accountId]?.attachmentRoots
              : undefined) ?? []),
            ...(cfg.channels?.imessage?.attachmentRoots ?? []),
            "/Users/*/Library/Messages/Attachments",
          ],
        };
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  ),
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
  listProfilesForProvider: (
    store: { profiles?: Record<string, { provider?: string }> },
    provider: string,
  ) =>
    Object.entries(store.profiles ?? {})
      .filter(([, profile]) => profile?.provider === provider)
      .map(([profileId]) => profileId),
  resolveAuthProfileOrder: (params: {
    cfg?: OpenClawConfig;
    store: { profiles?: Record<string, { provider?: string }> };
    provider: string;
  }) => {
    const profiles = Object.entries(params.store.profiles ?? {})
      .filter(([, profile]) => profile?.provider === params.provider)
      .map(([profileId]) => profileId);
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
  await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(profiles), "utf8");
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeAgentDir = () => tempDirs.make("openclaw-image-");
const priorFetch = global.fetch;
afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = priorFetch;
  imageProviderHarness.reset();
  testing.setProviderDepsForTest();
});

const inlinePng = `data:image/png;base64,${ONE_PIXEL_PNG_B64}`;
const imageRequest = { prompt: "Describe the image.", path: inlinePng };

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

async function makeWorkspacePng() {
  const workspaceDir = path.join(tempDirs.make("openclaw-workspace-image-"), "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const imagePath = path.join(workspaceDir, "photo.png");
  await writePng(imagePath);
  return { workspaceDir, imagePath };
}

function registerImageToolEnvReset(keys: string[]) {
  beforeEach(() => {
    for (const key of keys) {
      vi.stubEnv(key, "");
    }
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
  const fetch = vi.fn(async () => Response.json({ content, base_resp: baseResp }));
  global.fetch = withFetchPreconnect(fetch);
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

async function describeGenericImageWithModel(
  params: ImageDescriptionRequest | ImagesDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const multiple = "images" in params;
  const response = await global.fetch(
    `https://example.invalid/media-${multiple ? "images" : "image"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: params.provider,
        model: params.model,
        prompt: params.prompt,
        ...(multiple ? { imageCount: params.images.length } : { mime: params.mime }),
      }),
    },
  );
  const payload = (await response.json()) as { content?: string };
  return { text: payload.content ?? "", model: params.model };
}

const imageRuntimeDeps = {
  buildProviderRegistry: imageProviderHarness.buildProviderRegistry,
  getMediaUnderstandingProvider: imageProviderHarness.getMediaUnderstandingProvider,
  describeImageWithModel: describeGenericImageWithModel,
  describeImagesWithModel: describeGenericImageWithModel,
};

const codexMediaProvider = {
  id: "codex",
  capabilities: ["image"],
  defaultModels: { image: "gpt-5.5" },
} satisfies MediaUnderstandingProvider;

function installImageUnderstandingProviderDeps(
  providers: MediaUnderstandingProvider[],
  options?: Pick<
    NonNullable<Parameters<typeof testing.setProviderDepsForTest>[0]>,
    | "describeImageWithModel"
    | "describeImagesWithModel"
    | "loadImageWebMediaRuntime"
    | "resolveImageCompressionPolicy"
    | "resolveModelAsync"
  > & { useDefaultResolveModelAsync?: boolean },
) {
  imageProviderHarness.setProviders(providers);
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
  testing.setProviderDepsForTest({
    ...imageRuntimeDeps,
    describeImageWithModel: options?.describeImageWithModel ?? describeGenericImageWithModel,
    describeImagesWithModel: options?.describeImagesWithModel ?? describeGenericImageWithModel,
    resolveAutoMediaKeyProviders: ({ capability }) =>
      capability === "image" ? ["openai", "anthropic"] : [],
    resolveDefaultMediaModel: ({ providerId, capability }) =>
      capability === "image" ? defaultImageModels.get(providerId.toLowerCase()) : undefined,
    resolveRegisteredMediaUnderstandingProvider: ({ providerId }) =>
      imageProviderHarness.getMediaUnderstandingProvider(
        providerId,
        imageProviderHarness.buildProviderRegistry(),
      ),
    ...(options?.useDefaultResolveModelAsync
      ? {}
      : { resolveModelAsync: options?.resolveModelAsync ?? resolveConfiguredImageModelForTest }),
    ...(options?.resolveImageCompressionPolicy
      ? { resolveImageCompressionPolicy: options.resolveImageCompressionPolicy }
      : {}),
    ...(options?.loadImageWebMediaRuntime
      ? { loadImageWebMediaRuntime: options.loadImageWebMediaRuntime }
      : {}),
  });
}

function installFastLocalImageProviderStubs(...providers: MediaUnderstandingProvider[]) {
  const unexpectedFallback = async () => {
    throw new Error("Expected fast local image tests to use a registered image provider");
  };
  installImageUnderstandingProviderDeps(providers, {
    describeImageWithModel: unexpectedFallback,
    describeImagesWithModel: unexpectedFallback,
    resolveImageCompressionPolicy: async ({ imageCount }) => ({ imageCount }),
    loadImageWebMediaRuntime: async () =>
      createImageWebMediaRuntime(
        async (mediaUrl, { localRoots = [], inboundRoots = [], readFile } = {}) => {
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
        },
      ),
  });
}

function makeConfig(
  defaults: AgentDefaultsConfig,
  providers?: Record<string, ModelProviderConfig>,
): OpenClawConfig {
  return { agents: { defaults }, ...(providers ? { models: { providers } } : {}) };
}

function modelProvider(
  baseUrl: string,
  models: ModelProviderConfig["models"],
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return { baseUrl, models, ...overrides };
}

function imageProvider(
  id: string,
  describeImage: MediaUnderstandingProvider["describeImage"],
): MediaUnderstandingProvider {
  return { id, capabilities: ["image"], describeImage };
}

function makeImageDescriptionSpy() {
  return vi.fn(async (params: ImageDescriptionRequest) => ({ text: "ok", model: params.model }));
}

async function writePng(filePath: string) {
  await fs.writeFile(filePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
}

async function expectImageToolExecOk(tool: ImageToolInstance, imagePath: string) {
  const result = await tool.execute("t1", {
    prompt: "Describe the image.",
    path: imagePath,
  });
  expectToolText(result, "ok");
  expect(result.details).toMatchObject({ text: "ok" });
}

function expectToolText(
  result: Awaited<ReturnType<ImageToolInstance["execute"]>>,
  text: string,
): void {
  const content = result.content;
  expect(content.some((block) => block.type === "text" && block.text === text)).toBe(true);
}

function firstImageRequest(
  mock: ReturnType<typeof makeImageDescriptionSpy>,
): ImageDescriptionRequest {
  return expectDefined(mock.mock.calls[0]?.[0], "expected describeImage call");
}

type ImageToolInstance = ReturnType<typeof createRequiredImageTool>;

async function makeSandboxState() {
  const stateDir = tempDirs.make("openclaw-image-sandbox-");
  const agentDir = path.join(stateDir, "agent");
  const sandboxRoot = path.join(stateDir, "sandbox");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  return { agentDir, sandboxRoot };
}

function makeMinimaxTool() {
  return createRequiredImageTool({ config: createMinimaxImageConfig(), agentDir: makeAgentDir() });
}

describe("image tool implicit imageModel config", () => {
  type Profiles = AuthProfileStore["profiles"];
  const openAiPrimaryCfg = makeConfig({ model: { primary: "openai/gpt-5.4" } });
  const codexImageModel = { primary: "codex/gpt-5.5" };

  const openAiOAuthProfile = (provider = "openai"): AuthProfileCredential => ({
    provider,
    type: "oauth" as const,
    access: "oauth-test",
    refresh: "refresh-test",
    expires: Date.now() + 60_000,
  });

  const makeAuthStore = (profiles: Profiles): AuthProfileStore => ({ version: 1, profiles });
  const writeProfiles = (agentDir: string, profiles: Profiles) =>
    writeAuthProfiles(agentDir, makeAuthStore(profiles));

  registerImageToolEnvReset([
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
    installImageUnderstandingProviderDeps([minimaxProvider]);
  });

  it.each([
    { name: "no auth", persisted: false, scoped: false, prepared: false, cli: false },
    { name: "no prepared provider", persisted: true, scoped: false, prepared: true, cli: false },
    { name: "external CLI OAuth", persisted: false, scoped: false, prepared: false, cli: true },
    { name: "scoped empty store", persisted: true, scoped: true, prepared: false, cli: false },
  ])(
    "resolves implicit OpenAI image auth with $name",
    async ({ persisted, scoped, prepared, cli }) => {
      const agentDir = makeAgentDir();
      if (persisted) {
        await writeProfiles(agentDir, { "openai:chatgpt": openAiOAuthProfile() });
      }
      if (persisted || cli) {
        installImageUnderstandingProviderDeps([minimaxProvider, codexMediaProvider]);
      }
      if (cli) {
        vi.stubEnv("OPENCLAW_TEST_CODEX_CLI_OAUTH", "1");
      }
      expect(
        resolveImageModelConfigForTool({
          cfg: openAiPrimaryCfg,
          agentDir,
          authStore:
            persisted || cli
              ? scoped
                ? makeAuthStore({})
                : readMockRuntimeAuthProfileStore(agentDir)
              : undefined,
          preparedModelRuntime: prepared
            ? ({ mediaCapabilityProviders: { mediaUnderstandingProviders: [] } } as never)
            : undefined,
        }),
      ).toEqual(cli ? codexImageModel : null);
      if (!persisted && !cli) {
        expect(createImageTool({ config: openAiPrimaryCfg, agentDir })).toBeNull();
      }
    },
  );

  it("pairs minimax-portal primary with MiniMax-VL-01 and fallbacks", async () => {
    const cfg = makeConfig({ model: { primary: "minimax-portal/MiniMax-M2.7" } });
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const agentDir = makeAgentDir();
    await writeProfiles(agentDir, {
      "minimax-portal:default": openAiOAuthProfile("minimax-portal"),
    });

    const actual = resolveImageModelConfigForTool({
      cfg,
      agentDir,
      authStore: readMockRuntimeAuthProfileStore(agentDir),
    });
    expect(actual).toEqual({
      primary: "minimax-portal/MiniMax-VL-01",
      fallbacks: ["openai/gpt-5.4-mini", "anthropic/claude-opus-4-6"],
    });
    expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
  });

  it("defers implicit image model discovery during hot-path tool registration", async () => {
    const agentDir = makeAgentDir();
    const resolveDefaultMediaModelSpy = vi.fn(() => "gpt-5.4-mini");
    const resolveAutoMediaKeyProvidersSpy = vi.fn(() => ["openai"]);
    testing.setProviderDepsForTest({
      ...imageRuntimeDeps,
      resolveDefaultMediaModel: resolveDefaultMediaModelSpy,
      resolveAutoMediaKeyProviders: resolveAutoMediaKeyProvidersSpy,
    });
    const cfg = makeConfig({ model: { primary: "openai/gpt-5.4" } });

    const tool = createImageTool({
      config: cfg,
      agentDir,
      deferAutoModelResolution: true,
    });

    expect(typeof tool?.execute).toBe("function");
    expect(resolveDefaultMediaModelSpy).not.toHaveBeenCalled();
    expect(resolveAutoMediaKeyProvidersSpy).not.toHaveBeenCalled();
  });

  it("honors a per-call model override when no imageModel is configured", async () => {
    const agentDir = makeAgentDir();
    const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
      text: `ok ${params.provider}/${params.model}`,
      model: params.model,
    }));
    installFastLocalImageProviderStubs(imageProvider("opencode-go", describeImage));
    const cfg = makeConfig({ model: { primary: "opencode-go/kimi-k2.6" } });
    const tool = createRequiredImageTool({
      config: cfg,
      agentDir,
      deferAutoModelResolution: true,
    });

    const result = await tool.execute("t1", {
      prompt: "Describe this image.",
      path: inlinePng,
      model: "opencode-go/mimo-v2.5",
    });

    expect(firstImageRequest(describeImage)).toMatchObject({
      provider: "opencode-go",
      model: "mimo-v2.5",
    });
    expectToolText(result, "ok opencode-go/mimo-v2.5");
  });

  it("carries the scoped auth store into image provider execution", async () => {
    const agentDir = makeAgentDir();
    const describeImage = makeImageDescriptionSpy();
    installImageUnderstandingProviderDeps([imageProvider("codex", describeImage)]);
    const authProfileStore = makeAuthStore({
      "openai:scoped": openAiOAuthProfile(),
    });
    const tool = createRequiredImageTool({
      config: { agents: { defaults: { imageModel: { primary: "codex/gpt-5.5" } } } },
      agentDir,
      authProfileStore,
    });

    await tool.execute("t1", { prompt: "Describe this image.", path: inlinePng });

    expect(firstImageRequest(describeImage).authStore).toBe(authProfileStore);
  });

  it.each([
    { name: "ignores chat metadata", primary: true, cnCandidate: true, auto: false },
    { name: "prefers the configured CN alias", primary: false, cnCandidate: true, auto: true },
    { name: "retains the canonical fallback", primary: false, cnCandidate: false, auto: true },
  ])("routes MiniMax image models: $name", async ({ primary, cnCandidate, auto }) => {
    const agentDir = makeAgentDir();
    if (auto) {
      const defaultImageModels = new Map<string, string>([
        ["anthropic", "claude-opus-4-6"],
        ["minimax", "MiniMax-VL-01"],
        ["minimax-cn", "MiniMax-VL-01"],
        ["openai", "gpt-5.4-mini"],
      ]);
      testing.setProviderDepsForTest({
        ...imageRuntimeDeps,
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
            models: cnCandidate ? [makeModelDefinition("MiniMax-M2.5")] : [],
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

    expect(resolveImageModelConfigForTool({ cfg, agentDir, authStore })).toEqual({
      primary: `${cnCandidate ? "minimax-cn" : "minimax"}/MiniMax-VL-01`,
    });
  });

  it.each([
    { name: "capability timeout", modelTimeout: undefined, expected: 180_000 },
    { name: "matching model timeout", modelTimeout: 300, expected: 300_000 },
  ])("uses $name for provider calls", async ({ modelTimeout, expected }) => {
    const { workspaceDir, imagePath } = await makeWorkspacePng();
    const agentDir = makeAgentDir();
    const describeImage = makeImageDescriptionSpy();
    installFastLocalImageProviderStubs(imageProvider("ollama", describeImage));
    const model = "gemma4:26b-a4b-it-q4_K_M";
    const cfg = makeConfig({ imageModel: { primary: `ollama/${model}` } });
    cfg.tools = {
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
    };
    const tool = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });
    await expectImageToolExecOk(tool, imagePath);
    expect(firstImageRequest(describeImage).timeoutMs).toBe(expected);
  });

  it.each([
    { provider: "acme", model: "vision-1", prefixed: false, checkTool: true },
    { provider: "kimchi", model: "vision-1", prefixed: true, checkTool: false },
  ])(
    "pairs configured image model $provider/$model",
    async ({ provider, model, prefixed, checkTool }) => {
      const agentDir = makeAgentDir();
      const authStore = createAuthProfileStoreFixture({
        [`${provider}:default`]: createApiKeyCredential(provider, "sk-test"),
      });
      await writeAuthProfiles(agentDir, authStore);
      const cfg = makeConfig(
        { model: { primary: `${provider}/text-1` } },
        {
          [provider]: modelProvider("https://example.com", [
            makeModelDefinition(prefixed ? `${provider}/text-1` : "text-1", ["text"]),
            makeModelDefinition(prefixed ? `${provider}/${model}` : model),
          ]),
        },
      );
      expect(
        resolveImageModelConfigForTool({
          cfg,
          agentDir,
          authStore,
        }),
      ).toEqual({ primary: `${provider}/${model}` });
      if (checkTool) {
        // Direct factories retain their shipped directory-backed auth contract.
        expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
        expect(typeof createPdfTool({ config: cfg, agentDir })?.execute).toBe("function");
      }
    },
  );

  it("does not pair provider aliases through core normalization", async () => {
    const agentDir = makeAgentDir();
    await writeAuthProfiles(
      agentDir,
      createAuthProfileStoreFixture({
        "amazon-bedrock:default": createApiKeyCredential("amazon-bedrock", "sk-test"),
      }),
    );
    const cfg = makeConfig(
      { model: { primary: "aws-bedrock/text-1" } },
      {
        "amazon-bedrock": modelProvider("https://example.com", [
          makeModelDefinition("text-1", ["text"]),
          makeModelDefinition("vision-1"),
        ]),
      },
    );
    expect(
      resolveImageModelConfigForTool({
        cfg,
        agentDir,
        authStore: readMockRuntimeAuthProfileStore(agentDir),
      }),
    ).toBeNull();
  });

  it.each([
    { ref: "moondream", ambiguous: true },
    { ref: "gpt-5.4-mini", ambiguous: false },
  ])("resolves providerless image model $ref", ({ ref, ambiguous }) => {
    const cfg = makeConfig(
      { imageModel: { primary: ref } },
      ambiguous
        ? {
            ollama: modelProvider("http://localhost:11434", [makeModelDefinition("moondream")]),
            lmstudio: modelProvider("http://localhost:1234", [makeModelDefinition("moondream")]),
          }
        : undefined,
    );
    const resolve = () =>
      resolveImageModelConfigForTool({
        cfg,
        agentDir: makeAgentDir(),
        authStore: createAuthProfileStoreFixture({}),
      });
    if (ambiguous) {
      expect(resolve).toThrow(/Ambiguous image model "moondream"/);
    } else {
      expect(resolve()).toEqual({ primary: "gpt-5.4-mini" });
    }
  });

  it("loads images directly for native-vision models without resolving an image model", async () => {
    const agentDir = makeAgentDir();
    const cfg = makeConfig(
      {
        model: { primary: "acme/vision-1" },
        imageModel: { primary: "moondream" },
        imageMaxDimensionPx: 32,
      },
      {
        acme: modelProvider("https://example.com", [makeModelDefinition("vision-1")]),
        ollama: modelProvider("http://localhost:11434", [makeModelDefinition("moondream")]),
        lmstudio: modelProvider("http://localhost:1234", [makeModelDefinition("moondream")]),
      },
    );
    const describeImageWithModel = vi.fn(async () => {
      throw new Error("native image loading must not call a fallback model");
    });
    const describeImagesWithModel = vi.fn(async () => {
      throw new Error("native image loading must not call a fallback model");
    });
    testing.setProviderDepsForTest({ describeImageWithModel, describeImagesWithModel });

    const tool = createRequiredImageTool({ config: cfg, agentDir, modelHasVision: true });
    expect(tool).toMatchObject({
      name: "view_image",
      label: "View Image",
      catalogMode: "direct-only",
    });
    expect(tool.description).toContain("private model context");
    expect(tool.description).toContain("Does not display, attach, or send");

    const result = await tool.execute("native-image", {
      prompt: "Read the screenshot error.",
      path: inlinePng,
    });
    const content = result.content;

    expect(content).toEqual([
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
      const agentDir = makeAgentDir();
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
    const tool = makeMinimaxTool();
    await expect(
      tool.execute("legacy-image-arg", {
        image: inlinePng,
      }),
    ).rejects.toThrow("path required");
  });

  it("preserves the unsupported image reference result contract", async () => {
    const tool = makeMinimaxTool();
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
      const { workspaceDir, imagePath } = await makeWorkspacePng();
      const fetch = stubMinimaxOkFetch();
      const agentDir = makeAgentDir();
      const cfg = createMinimaxImageConfig();
      const tool = createRequiredImageTool({
        config: cfg,
        agentDir,
        ...(workspaceOnly === true ? { workspaceDir } : {}),
        ...(workspaceOnly === undefined ? {} : { fsPolicy: { workspaceOnly } }),
      });
      let deniedPath = imagePath;
      if (workspaceOnly === true) {
        await expectImageToolExecOk(tool, imagePath);
        expect(fetch).toHaveBeenCalledTimes(1);
        deniedPath = path.join(path.dirname(workspaceDir), "secret.png");
        await writePng(deniedPath);
      }
      await expect(
        tool.execute("denied", { prompt: "Describe.", path: deniedPath }),
      ).rejects.toThrow(/not under an allowed directory/i);
      if (workspaceOnly === undefined) {
        const withWorkspace = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });
        await expectImageToolExecOk(withWorkspace, imagePath);
        expect(fetch).toHaveBeenCalledTimes(1);
      } else if (!workspaceOnly) {
        expect(fetch).not.toHaveBeenCalled();
      }
    },
  );

  it("allows current iMessage account attachments", async () => {
    const agentDir = makeAgentDir();
    const describeImage = makeImageDescriptionSpy();
    installFastLocalImageProviderStubs(imageProvider("ollama", describeImage));
    const attachmentRoot = tempDirs.make("openclaw-imessage-root-");
    const imagePath = path.join(attachmentRoot, "photo.png");
    await writePng(imagePath);
    const cfg = makeConfig(
      { imageModel: { primary: "ollama/moondream" } },
      {
        ollama: modelProvider("http://localhost:11434", [makeModelDefinition("moondream")]),
      },
    );
    cfg.channels = { imessage: { accounts: { work: { attachmentRoots: [attachmentRoot] } } } };
    const withoutChannel = createRequiredImageTool({ config: cfg, agentDir });
    await expect(
      withoutChannel.execute("t1", { prompt: "Describe.", path: imagePath }),
    ).rejects.toThrow(/not under an allowed directory/i);
    const withImessage = createRequiredImageTool({
      config: cfg,
      agentDir,
      agentChannel: "imessage",
      agentAccountId: "work",
    });
    await expectImageToolExecOk(withImessage, imagePath);
    expect(describeImage).toHaveBeenCalledTimes(1);
  });

  it("passes web_fetch SSRF policy to remote image references", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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

    const agentDir = makeAgentDir();
    const cfg: OpenClawConfig = {
      ...createMinimaxImageConfig(),
      tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
    };
    const tool = createRequiredImageTool({ config: cfg, agentDir });

    await expectImageToolExecOk(tool, "http://198.18.0.153/reference.png");
    const [input, init] = expectDefined(fetch.mock.calls[0], "first fetch call");
    expect(input).toBe("http://198.18.0.153/reference.png");
    expect(typeof init).toBe("object");
  });

  it("sandboxes image paths like the read tool", async () => {
    const { agentDir, sandboxRoot } = await makeSandboxState();
    const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };

    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = makeConfig({ model: { primary: "minimax/MiniMax-M2.7" } });
    const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

    await expect(tool.execute("t1", { path: "https://example.com/a.png" })).rejects.toThrow(
      /Sandboxed view_image does not allow remote URLs/i,
    );

    await expect(tool.execute("t2", { path: "../escape.png" })).rejects.toThrow(
      /escapes sandbox root/i,
    );
  });

  it("reads a mounted image from FILE:/workspace/img.png", async () => {
    const { agentDir, sandboxRoot } = await makeSandboxState();
    await writePng(path.join(sandboxRoot, "img.png"));
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
    const { agentDir, sandboxRoot } = await makeSandboxState();
    await writePng(path.join(agentDir, "secret.png"));
    const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot: agentDir });
    const bridge = sandbox.fsBridge;
    if (!bridge) {
      throw new Error("expected unsafe sandbox filesystem bridge");
    }
    const fetch = stubMinimaxOkFetch();
    const imageTool = createRequiredImageTool({
      config: createMinimaxImageConfig(),
      agentDir,
      workspaceDir: sandboxRoot,
      sandbox: { root: sandboxRoot, bridge },
      fsPolicy: { workspaceOnly: true },
    });
    await expect(
      imageTool.execute("t1", {
        prompt: "Describe the image.",
        path: "/agent/secret.png",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    const { agentDir, sandboxRoot } = await makeSandboxState();
    await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), {
      recursive: true,
    });
    await writePng(path.join(sandboxRoot, "media", "inbound", "photo.png"));

    const fetch = stubMinimaxOkFetch();

    const cfg = { agents: createMinimaxImageConfig().agents };
    const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
    const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      path: "@/Users/steipete/.openclaw/media/inbound/photo.png",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((res.details as { rewrittenFrom?: string }).rewrittenFrom).toContain("photo.png");
  });

  it("resolves a producer-staged bare upload handle", async () => {
    const { agentDir, sandboxRoot } = await makeSandboxState();
    const stagedPath = "media/inbound/openclaw-staged-proof/input-file_upload.png";
    await fs.mkdir(path.dirname(path.join(sandboxRoot, stagedPath)), { recursive: true });
    await writePng(path.join(sandboxRoot, stagedPath));

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

    await writePng(path.join(sandboxRoot, "file_upload"));
    const direct = await tool.execute("t2", { path: "file_upload" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(direct.details).not.toHaveProperty("rewrittenFrom");
  });
});

it.each([
  {
    dataUrl: "data:text/plain;base64,SGVsbG8=",
    maxBytes: undefined,
    error: /Unsupported data URL type/i,
  },
  { dataUrl: `data:image/png;base64,${"A".repeat(16)}`, maxBytes: 4, error: /size limit/i },
])(
  "image tool rejects invalid data URLs before decoding: $error",
  ({ dataUrl, maxBytes, error }) => {
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => testing.decodeDataUrl(dataUrl, { maxBytes })).toThrow(error);
      expect(bufferFromSpy).not.toHaveBeenCalledWith(dataUrl.split(",")[1], "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  },
);

describe("image tool MiniMax VLM routing", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "minimax-vlm", applyEnv: false });
    installImageUnderstandingProviderDeps([minimaxProvider]);
  });

  afterEach(async () => {
    await state.cleanup();
  });

  async function createMinimaxVlmFixture(baseResp: { status_code: number; status_msg: string }) {
    const fetchMock = stubMinimaxFetch(baseResp, baseResp.status_code === 0 ? "ok" : "");

    const agentDir = state.agentDir();
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = createMinimaxImageConfig();
    const tool = createRequiredImageTool({ config: cfg, agentDir });
    return { fetch: fetchMock, tool, cfg, agentDir };
  }

  it("combines path + paths with dedupe and enforces maxImages", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });
    const secondPngB64 = createLargeColorBlockPng(2).toString("base64");

    const deduped = await tool.execute("t1", {
      prompt: "Compare these images.",
      maxImages: "2",
      maxBytesMb: "1",
      path: inlinePng,
      paths: [
        inlinePng,
        `data:image/png;base64,${secondPngB64}`,
        `data:image/png;base64,${secondPngB64}`,
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(deduped.details).toMatchObject({ images: [expect.any(Object), expect.any(Object)] });

    const tooMany = await tool.execute("t2", {
      prompt: "Compare these images.",
      path: inlinePng,
      paths: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tooMany.details).toMatchObject({ error: "too_many_images", count: 2, max: 1 });
  });

  it("rejects invalid image cap values before loading images", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    await expect(
      tool.execute("t1", {
        prompt: "Compare these images.",
        path: inlinePng,
        maxImages: 1.5,
      }),
    ).rejects.toThrow("maxImages must be a positive integer");

    await expect(
      tool.execute("t2", {
        prompt: "Compare these images.",
        path: inlinePng,
        maxBytesMb: 0,
      }),
    ).rejects.toThrow("maxBytesMb must be greater than 0");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces MiniMax API errors from /v1/coding_plan/vlm", async () => {
    const { tool, cfg, agentDir } = await createMinimaxVlmFixture({
      status_code: 1004,
      status_msg: "bad key",
    });
    const generation = createModelGenerationFixture({
      agentDir,
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
        tool.execute("t1", imageRequest),
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
  function createAssistantMessage(overrides: Partial<AssistantMessage>) {
    return makeAssistantMessageFixture({
      model: "gpt-5.4-mini",
      stopReason: "stop",
      errorMessage: undefined,
      content: [],
      ...overrides,
    });
  }

  it("surfaces provider errors from image-model responses", () => {
    expect(() =>
      testing.coerceImageAssistantText({
        provider: "openai",
        model: "gpt-5.4-mini",
        message: createAssistantMessage({ stopReason: "error", errorMessage: "boom" }),
      }),
    ).toThrow(/boom/i);
  });

  it("returns trimmed text from image-model responses", () => {
    expect(
      testing.coerceImageAssistantText({
        provider: "anthropic",
        model: "claude-opus-4-6",
        message: createAssistantMessage({
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "  hello  " }],
        }),
      }),
    ).toBe("hello");
  });

  it.each<[string, unknown, boolean, boolean, number]>([
    ["reasoning_content", "reasoning_content", true, true, 0],
    ["Responses JSON", JSON.stringify({ id: "rs_123", type: "reasoning" }), true, true, 0],
    ["Responses object", { id: "rs_456", type: "reasoning.encrypted" }, true, true, 0],
    [
      "oversized Responses JSON",
      JSON.stringify({
        id: "rs_123",
        summary: [{ text: "x".repeat(2_100) }],
        type: "reasoning",
      }),
      true,
      false,
      0,
    ],
    ["signature after bounded block scan", "reasoning_content", false, false, 50],
  ])(
    "detects image reasoning-only responses: %s",
    (_name, signature, expected, rejectText, precedingBlocks) => {
      const message = createAssistantMessage({
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
      } as never);
      expect(testing.hasImageReasoningOnlyResponse(message)).toBe(expected);
      if (rejectText) {
        expect(() =>
          testing.coerceImageAssistantText({
            provider: "openai",
            model: "gpt-5.4-mini",
            message,
          }),
        ).toThrow(/returned no text/i);
      }
    },
  );
});

describe("image compression policy", () => {
  const cfgWithImageModelMetadata = makeConfig(
    { imageQuality: "high" },
    {
      anthropic: modelProvider(
        "https://api.anthropic.com",
        [makeModelDefinition("claude-opus-4-6")],
        {
          api: "anthropic-messages",
        },
      ),
      openai: modelProvider(
        "https://api.openai.com/v1",
        [
          {
            ...makeModelDefinition("gpt-5.5"),
            mediaInput: { image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" } },
          },
        ],
        { api: "openai-responses" },
      ),
    },
  );

  beforeEach(() => {
    installImageUnderstandingProviderDeps([]);
  });

  it("keeps image policy pinned to the prepared generation: static catalog", async () => {
    const state = await createOpenClawTestState({ label: "image-model-generation" });
    try {
      const provider = "prepared-image-provider";
      const model = "prepared-image-model";
      const cfg = {} satisfies OpenClawConfig;
      const generation = (
        label: string,
        staticImagePolicy: Parameters<typeof createModelGenerationFixture>[0]["staticImagePolicy"],
        maxSidePx: number,
      ) =>
        createModelGenerationFixture({
          agentDir: state.agentDir("prepared"),
          workspaceDir: state.workspaceDir,
          config: cfg,
          label,
          provider,
          requestProvider: provider,
          modelId: model,
          runtimeAugment: false,
          staticImagePolicy,
          runtimeImagePolicy: { maxSidePx },
        });
      const generationA = generation(
        "image-a",
        {
          maxBytes: 1_000_000,
          preferredSidePx: 1_280,
          tokenMode: "detail",
        },
        1_440,
      );
      const generationB = generation(
        "image-b",
        {
          maxBytes: 2_000_000,
          preferredSidePx: 2_560,
          tokenMode: "provider",
        },
        2_880,
      );
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
      expect(generationA.resolveDynamicModel).toHaveBeenCalledOnce();
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
        const cfg = makeConfig(
          {
            imageQuality: "high",
            imageModel: {
              primary: `${provider}/${route === "fallback" ? "unavailable" : "entry"}`,
              ...(route === "fallback" ? { fallbacks: [`${provider}/entry`] } : {}),
            },
          },
          {
            [provider]: modelProvider(
              "https://image-planning.example.test/v1",
              [
                { id: "captured", side: 96 },
                { id: "ambient", side: 192 },
                { id: "unavailable", side: 256 },
              ].map(({ id, side }) =>
                Object.assign(makeModelDefinition(id), {
                  mediaInput: { image: { maxSidePx: side, preferredSidePx: side } },
                }),
              ),
              { api: "openai-completions" },
            ),
          },
        );
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
          preparedModelRuntime: supplied === "none" ? undefined : captured.preparedModelRuntime,
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
