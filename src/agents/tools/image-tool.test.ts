// Image tool tests cover model routing, provider auth, path safety, inbound
// media refs, data URLs, and compression policy.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
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
import { createImageTool } from "./image-tool.js";
import {
  createLargeColorBlockPng,
  createMinimaxImageConfig,
  createRequiredImageTool,
  executeImplicitImageTool,
  expectToolText,
  ONE_PIXEL_PNG_B64,
  readJpegDimensions,
  replyImageOk,
  resolveConfiguredImageModelForTest,
  testing,
  type ToolTextResult,
} from "./image-tool.test-support.js";
import { resolveMediaToolInboundRoots } from "./media-tool-shared.js";
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
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG dimensions not found");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function withTempWorkspacePng(
  cb: (args: { workspaceDir: string; imagePath: string }) => Promise<void>,
  options?: { parentDir?: string },
) {
  const parentDir = options?.parentDir ?? os.tmpdir();
  const workspaceParent = await fs.mkdtemp(path.join(parentDir, "openclaw-workspace-image-"));
  try {
    const workspaceDir = path.join(workspaceParent, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    await cb({ workspaceDir, imagePath });
  } finally {
    await fs.rm(workspaceParent, { recursive: true, force: true });
  }
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
  minimaxUnderstandImageMock.mockReset();
  vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
  minimaxUnderstandImageMock.mockResolvedValue("ok");
  // Tests that fall back to the generic image runtime still hit a mocked
  // global.fetch because media-understanding/image.ts is not behind the
  // minimax-vlm module mock.
  const fetch = vi.fn().mockImplementation(async () =>
    Response.json({
      content: "ok",
      base_resp: { status_code: 0, status_msg: "" },
    }),
  );
  global.fetch = withFetchPreconnect(fetch);
  return minimaxUnderstandImageMock;
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
  const fetch = vi.fn().mockImplementation(async () =>
    Response.json({
      content,
      base_resp: baseResp,
    }),
  );
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

async function readMockResponseText(response: Response): Promise<string> {
  const payload = (await response.json()) as { content?: string };
  return payload.content ?? "";
}

async function describeGenericImageWithModel(
  params: ImageDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const response = await global.fetch("https://example.invalid/media-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      mime: params.mime,
    }),
  });
  return { text: await readMockResponseText(response), model: params.model };
}

async function describeGenericImagesWithModel(
  params: ImagesDescriptionRequest,
): Promise<{ text: string; model: string }> {
  const response = await global.fetch("https://example.invalid/media-images", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model,
      prompt: params.prompt,
      imageCount: params.images.length,
    }),
  });
  return { text: await readMockResponseText(response), model: params.model };
}

const codexMediaProvider = {
  id: "codex",
  capabilities: ["image"],
  defaultModels: { image: "gpt-5.5" },
} satisfies MediaUnderstandingProvider;

function installImageUnderstandingProviderDeps(
  providers: MediaUnderstandingProvider[],
  options?: {
    describeImageWithModel?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["describeImageWithModel"];
    describeImagesWithModel?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["describeImagesWithModel"];
    loadImageWebMediaRuntime?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["loadImageWebMediaRuntime"];
    resolveImageCompressionPolicy?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["resolveImageCompressionPolicy"];
    resolveModelAsync?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["resolveModelAsync"];
    useDefaultResolveModelAsync?: boolean;
    resolveAutoMediaKeyProviders?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["resolveAutoMediaKeyProviders"];
    resolveDefaultMediaModel?: NonNullable<
      Parameters<typeof testing.setProviderDepsForTest>[0]
    >["resolveDefaultMediaModel"];
  },
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
    buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
      imageProviderHarness.buildProviderRegistry(overrides),
    getMediaUnderstandingProvider: (
      id: string,
      registry: Map<string, MediaUnderstandingProvider>,
    ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
    describeImageWithModel: options?.describeImageWithModel ?? describeGenericImageWithModel,
    describeImagesWithModel: options?.describeImagesWithModel ?? describeGenericImagesWithModel,
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

function installImageUnderstandingProviderStubs(...providers: MediaUnderstandingProvider[]) {
  installImageUnderstandingProviderDeps(providers);
}

function installFastLocalImageProviderStubs(...providers: MediaUnderstandingProvider[]) {
  installImageUnderstandingProviderDeps(providers, {
    describeImageWithModel: async () => {
      throw new Error("Expected fast local image tests to use a registered image provider");
    },
    describeImagesWithModel: async () => {
      throw new Error("Expected fast local image tests to use a registered image provider");
    },
    resolveImageCompressionPolicy: async ({ imageCount }) => ({ imageCount }),
    loadImageWebMediaRuntime: async () => ({
      loadWebMedia: async (mediaUrl, options) => {
        const localRoots =
          options && typeof options !== "number" && "localRoots" in options
            ? options.localRoots
            : [];
        const inboundRoots =
          options && typeof options !== "number" && "inboundRoots" in options
            ? options.inboundRoots
            : [];
        if (
          localRoots !== "any" &&
          !isInboundPathAllowed({
            filePath: mediaUrl,
            roots: [...(localRoots ?? []), ...(inboundRoots ?? [])],
          })
        ) {
          throw new Error(`Local media path is not under an allowed directory: ${mediaUrl}`);
        }
        const readFile =
          options && typeof options !== "number" && "readFile" in options
            ? options.readFile
            : undefined;
        return {
          buffer: readFile ? await readFile(mediaUrl) : await fs.readFile(mediaUrl),
          contentType: "image/png",
          kind: "image",
          fileName: path.basename(mediaUrl),
        };
      },
      optimizeImageBufferForWebMedia: async ({ buffer, contentType, fileName }) => {
        return {
          buffer,
          contentType: contentType ?? "image/png",
          kind: "image",
          fileName,
        };
      },
    }),
  });
}

function makeModelDefinition(id: string, input: Array<"text" | "image">): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function expectImageToolExecOk(
  tool: {
    execute: (toolCallId: string, input: { prompt: string; path: string }) => Promise<unknown>;
  },
  imagePath: string,
) {
  const result = await tool.execute("t1", {
    prompt: "Describe the image.",
    path: imagePath,
  });
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

type ImageToolInstance = ReturnType<typeof createRequiredImageTool>;

async function withTempSandboxState(
  run: (ctx: { stateDir: string; agentDir: string; sandboxRoot: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-sandbox-"));
  const agentDir = path.join(stateDir, "agent");
  const sandboxRoot = path.join(stateDir, "sandbox");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  try {
    await run({ stateDir, agentDir, sandboxRoot });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withMinimaxImageToolFromTempAgentDir(
  run: (tool: ImageToolInstance) => Promise<void>,
) {
  await withTempAgentDir(async (agentDir) => {
    const cfg = createMinimaxImageConfig();
    await run(createRequiredImageTool({ config: cfg, agentDir }));
  });
}

describe("image tool implicit imageModel config", () => {
  type Profiles = AuthProfileStore["profiles"];
  const openAiPrimaryCfg = {
    agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
  } satisfies OpenClawConfig;

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
      await withTempAgentDir(async (agentDir) => {
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
      });
    },
  );

  it("pairs minimax-portal primary with MiniMax-VL-01 and fallbacks", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "minimax-portal/MiniMax-M2.7" } } },
    };
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    await withTempAgentDir(async (agentDir) => {
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
  });

  it("defers implicit image model discovery during hot-path tool registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      const resolveDefaultMediaModelSpy = vi.fn(() => "gpt-5.4-mini");
      const resolveAutoMediaKeyProvidersSpy = vi.fn(() => ["openai"]);
      testing.setProviderDepsForTest({
        buildProviderRegistry: (overrides?: Record<string, MediaUnderstandingProvider>) =>
          imageProviderHarness.buildProviderRegistry(overrides),
        getMediaUnderstandingProvider: (
          id: string,
          registry: Map<string, MediaUnderstandingProvider>,
        ) => imageProviderHarness.getMediaUnderstandingProvider(id, registry),
        describeImageWithModel: describeGenericImageWithModel,
        describeImagesWithModel: describeGenericImagesWithModel,
        resolveDefaultMediaModel: resolveDefaultMediaModelSpy,
        resolveAutoMediaKeyProviders: resolveAutoMediaKeyProvidersSpy,
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      };

      const tool = createImageTool({
        config: cfg,
        agentDir,
      });

      expect(typeof tool?.execute).toBe("function");
      expect(resolveDefaultMediaModelSpy).not.toHaveBeenCalled();
      expect(resolveAutoMediaKeyProvidersSpy).not.toHaveBeenCalled();
    });
  });

  it("honors a per-call model override when no imageModel is configured", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
        text: `ok ${params.provider}/${params.model}`,
        model: params.model,
      }));
      installFastLocalImageProviderStubs({
        id: "opencode-go",
        capabilities: ["image"],
        describeImage,
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "opencode-go/kimi-k2.6" } } },
      };
      const tool = createRequiredImageTool({
        config: cfg,
        agentDir,
      });

      const result = await tool.execute("t1", {
        prompt: "Describe this image.",
        path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        model: "opencode-go/mimo-v2.5",
      });

      const request = firstImageRequest(describeImage);
      expect(request.provider).toBe("opencode-go");
      expect(request.model).toBe("mimo-v2.5");
      expectToolText(result, "ok opencode-go/mimo-v2.5");
    });
  });

  it("carries the scoped auth store into image provider execution", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(replyImageOk);
      installImageUnderstandingProviderStubs({
        id: "codex",
        capabilities: ["image"],
        describeImage,
      });
      const authProfileStore = makeAuthStore({
        "openai:scoped": openAiOAuthProfile(),
      });
      const tool = createRequiredImageTool({
        config: { agents: { defaults: { imageModel: { primary: "codex/gpt-5.5" } } } },
        agentDir,
        authProfileStore,
      });

      await tool.execute("t1", {
        prompt: "Describe this image.",
        path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(firstImageRequest(describeImage).authStore).toBe(authProfileStore);
    });
  });

  it.each([
    { name: "ignores chat metadata", primary: true, cnCandidate: true, auto: false },
    { name: "prefers the configured CN alias", primary: false, cnCandidate: true, auto: true },
    { name: "retains the canonical fallback", primary: false, cnCandidate: false, auto: true },
  ])("routes MiniMax image models: $name", async ({ primary, cnCandidate, auto }) => {
    await withTempAgentDir(async (agentDir) => {
      if (auto) {
        const defaultImageModels = new Map<string, string>([
          ["anthropic", "claude-opus-4-6"],
          ["minimax", "MiniMax-VL-01"],
          ["minimax-cn", "MiniMax-VL-01"],
          ["openai", "gpt-5.4-mini"],
        ]);
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
              models: cnCandidate ? [makeModelDefinition("MiniMax-M2.5", ["text", "image"])] : [],
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
  });

  it.each([
    { name: "capability timeout", modelTimeout: undefined, expected: 180_000 },
    { name: "matching model timeout", modelTimeout: 300, expected: 300_000 },
  ])("uses $name for provider calls", async ({ modelTimeout, expected }) => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      await withTempAgentDir(async (agentDir) => {
        const describeImage = vi.fn(replyImageOk);
        installFastLocalImageProviderStubs({
          id: "ollama",
          capabilities: ["image"],
          describeImage,
        });
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
        const tool = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });
        await expectImageToolExecOk(tool, imagePath);
        expect(firstImageRequest(describeImage).timeoutMs).toBe(expected);
      });
    });
  });

  it.each([
    { provider: "acme", model: "vision-1", prefixed: false, checkTool: true },
    { provider: "kimchi", model: "vision-1", prefixed: true, checkTool: false },
  ])(
    "pairs configured image model $provider/$model",
    async ({ provider, model, prefixed, checkTool }) => {
      await withTempAgentDir(async (agentDir) => {
        await writeAuthProfiles(
          agentDir,
          createAuthProfileStoreFixture({
            [`${provider}:default`]: { type: "api_key", provider, key: "sk-test" },
          }),
        );
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: { primary: `${provider}/text-1` } } },
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://example.com",
                models: [
                  makeModelDefinition(prefixed ? `${provider}/text-1` : "text-1", ["text"]),
                  makeModelDefinition(prefixed ? `${provider}/${model}` : model, ["text", "image"]),
                ],
              },
            },
          },
        };
        const { requests } = await executeImplicitImageTool({
          config: cfg,
          agentDir,
          authProfileStore: createAuthProfileStoreFixture({
            [`${provider}:default`]: { type: "api_key", provider, key: "sk-test" },
          }),
        });
        expect(requests).toEqual([`${provider}/${model}`]);
        if (checkTool) {
          // Direct image factories retain their shipped directory-backed auth contract.
          expect(typeof createImageTool({ config: cfg, agentDir })?.execute).toBe("function");
          expect(typeof createPdfTool({ config: cfg, agentDir })?.execute).toBe("function");
        }
      });
    },
  );

  it("does not pair provider aliases through core normalization", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(
        agentDir,
        createAuthProfileStoreFixture({
          "amazon-bedrock:default": createApiKeyCredential("amazon-bedrock", "sk-test"),
        }),
      );
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "aws-bedrock/text-1" } } },
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://example.com",
              models: [
                makeModelDefinition("text-1", ["text"]),
                makeModelDefinition("vision-1", ["text", "image"]),
              ],
            },
          },
        },
      };
      await expect(
        executeImplicitImageTool({
          config: cfg,
          agentDir,
          authProfileStore: readMockRuntimeAuthProfileStore(agentDir),
        }),
      ).rejects.toThrow(/No image model is configured/);
    });
  });

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
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { imageModel } },
        ...(providers
          ? {
              models: {
                providers: Object.fromEntries(
                  providers.map((provider) => [
                    provider,
                    {
                      baseUrl:
                        provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234",
                      models: (models ?? []).map((model) =>
                        makeModelDefinition(model, ["text", "image"]),
                      ),
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
  });

  it("loads images directly for native-vision models without resolving an image model", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "acme/vision-1" },
            imageModel: { primary: "moondream" },
            imageMaxDimensionPx: 32,
          },
        },
        models: {
          providers: {
            acme: {
              baseUrl: "https://example.com",
              models: [makeModelDefinition("vision-1", ["text", "image"])],
            },
            ollama: {
              baseUrl: "http://localhost:11434",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
            lmstudio: {
              baseUrl: "http://localhost:1234",
              models: [makeModelDefinition("moondream", ["text", "image"])],
            },
          },
        },
      };
      const describeImageWithModel = vi.fn(async () => {
        throw new Error("native image loading must not call a fallback model");
      });
      const describeImagesWithModel = vi.fn(async () => {
        throw new Error("native image loading must not call a fallback model");
      });
      testing.setProviderDepsForTest({ describeImageWithModel, describeImagesWithModel });

      const tool = createRequiredImageTool({ config: cfg, agentDir, modelHasVision: true });
      expect(tool.name).toBe("view_image");
      expect(tool.label).toBe("View Image");
      expect(tool.catalogMode).toBe("direct-only");
      expect(tool.description).toContain("private model context");
      expect(tool.description).toContain("Does not display, attach, or send");

      const result = await tool.execute("native-image", {
        prompt: "Read the screenshot error.",
        path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });
      const content = (
        result as {
          content?: Array<{ type?: string; data?: string; mimeType?: string }>;
          details?: Record<string, unknown>;
        }
      ).content;

      expect(content).toEqual([
        {
          type: "text",
          text: "Loaded 1 image into private model context for inspection; not displayed, attached, or sent to the user.",
        },
        expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
      ]);
      expect((result as { details?: Record<string, unknown> }).details).toMatchObject({
        transport: "native",
        media: { outbound: false },
      });
      expect(describeImageWithModel).not.toHaveBeenCalled();
      expect(describeImagesWithModel).not.toHaveBeenCalled();
    });
  });

  it.each([true, false])(
    "omits undecodable JPEGs (readable batch member: %s)",
    async (includeValid) => {
      await withTempAgentDir(async (agentDir) => {
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
      });
    },
  );

  it.each([{ name: "image", input: { image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}` } }])(
    "does not accept the legacy $name argument",
    async ({ input }) => {
      await withMinimaxImageToolFromTempAgentDir(async (tool) => {
        await expect(tool.execute("legacy-image-arg", input)).rejects.toThrow("path required");
      });
    },
  );

  it("preserves the unsupported image reference result contract", async () => {
    await withMinimaxImageToolFromTempAgentDir(async (tool) => {
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
  });

  it.each([undefined, true])(
    "enforces local image roots (workspaceOnly: %s)",
    async (workspaceOnly) => {
      await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
        const fetch = stubMinimaxOkFetch();
        await withTempAgentDir(async (agentDir) => {
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
            await fs.writeFile(deniedPath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
          }
          await expect(
            tool.execute("denied", { prompt: "Describe.", path: deniedPath }),
          ).rejects.toThrow(/not under an allowed directory/i);
          if (workspaceOnly === undefined) {
            const withWorkspace = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });
            await expectImageToolExecOk(withWorkspace, imagePath);
            expect(fetch).toHaveBeenCalledTimes(1);
          }
        });
      });
    },
  );

  it("allows current iMessage account attachments", async () => {
    await withTempAgentDir(async (agentDir) => {
      const describeImage = vi.fn(replyImageOk);
      installFastLocalImageProviderStubs({
        id: "ollama",
        capabilities: ["image"],
        describeImage,
      });
      const attachmentRootParent = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-imessage-root-"),
      );
      const attachmentRoot = attachmentRootParent;
      const imagePath = path.join(attachmentRoot, "photo.png");
      await fs.mkdir(attachmentRoot, { recursive: true });
      await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
      try {
        const cfg: OpenClawConfig = {
          agents: { defaults: { imageModel: { primary: "ollama/moondream" } } },
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434",
                models: [makeModelDefinition("moondream", ["text", "image"])],
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
        expect(resolveMediaToolInboundRoots({ cfg })).toEqual([]);
        const roots = resolveMediaToolInboundRoots({
          cfg,
          channelId: "imessage",
          accountId: "work",
        });
        expect(roots).toContain(attachmentRoot);
        expect(isInboundPathAllowed({ filePath: imagePath, roots })).toBe(true);
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
      } finally {
        await fs.rm(attachmentRootParent, { recursive: true, force: true });
      }
    });
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

    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        ...createMinimaxImageConfig(),
        tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir });

      await expectImageToolExecOk(tool, "http://198.18.0.153/reference.png");
      const [input, init] = fetchCallAt(fetch, 0);
      expect(input).toBe("http://198.18.0.153/reference.png");
      expect(typeof init).toBe("object");
    });
  });

  it("sandboxes image paths like the read tool", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(path.join(sandboxRoot, "img.png"), "fake", "utf8");
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };

      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

      await expect(tool.execute("t1", { path: "https://example.com/a.png" })).rejects.toThrow(
        /Sandboxed view_image does not allow remote URLs/i,
      );

      await expect(tool.execute("t2", { path: "../escape.png" })).rejects.toThrow(
        /escapes sandbox root/i,
      );
    });
  });

  it.each(["FILE:/workspace/img.png"])("reads a mounted image from %s", async (image) => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(sandboxRoot, "img.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
      const bridge = createContainerWorkspaceSandboxFsBridge(sandboxRoot);
      stubMinimaxOkFetch();
      const tool = createRequiredImageTool({
        config: createMinimaxImageConfig(),
        agentDir,
        workspaceDir: sandboxRoot,
        sandbox: { root: sandboxRoot, bridge },
        fsPolicy: { workspaceOnly: true },
      });

      await expectImageToolExecOk(tool, image);
    });
  });

  it("applies workspace-only policy to image paths in sandbox mode", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(agentDir, "secret.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
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
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(sandboxRoot, "media", "inbound", "photo.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );

      const fetch = stubMinimaxOkFetch();

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax/MiniMax-M2.7" },
            imageModel: { primary: "minimax/MiniMax-VL-01" },
          },
        },
      };
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
      const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

      const res = await tool.execute("t1", {
        prompt: "Describe the image.",
        path: "@/Users/steipete/.openclaw/media/inbound/photo.png",
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect((res.details as { rewrittenFrom?: string }).rewrittenFrom).toContain("photo.png");
    });
  });

  it("resolves a producer-staged bare upload handle", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
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
    using bufferFromSpy = vi.spyOn(Buffer, "from");

    expect(() => testing.decodeDataUrl(dataUrl, { maxBytes })).toThrow(error);
    expect(bufferFromSpy).not.toHaveBeenCalledWith(dataUrl.split(",")[1], "base64");
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
      path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      paths: [
        `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        `data:image/png;base64,${secondPngB64}`,
        `data:image/png;base64,${secondPngB64}`,
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const dedupedDetails = deduped.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(dedupedDetails?.images).toHaveLength(2);

    const tooMany = await tool.execute("t2", {
      prompt: "Compare these images.",
      path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      paths: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const tooManyDetails = tooMany.details as
      | {
          error?: string;
          count?: number;
          max?: number;
        }
      | undefined;
    expect(tooManyDetails?.error).toBe("too_many_images");
    expect(tooManyDetails?.count).toBe(2);
    expect(tooManyDetails?.max).toBe(1);
  });

  it("rejects invalid image cap values before loading images", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    await expect(
      tool.execute("t1", {
        prompt: "Compare these images.",
        path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        maxImages: 1.5,
      }),
    ).rejects.toThrow("maxImages must be a positive integer");

    await expect(
      tool.execute("t2", {
        prompt: "Compare these images.",
        path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
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
        tool.execute("t1", {
          prompt: "Describe the image.",
          path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        }),
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

describe("image compression policy", () => {
  const cfgWithImageModelMetadata = {
    agents: {
      defaults: {
        imageQuality: "high",
      },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [
            {
              id: "claude-opus-4-7",
              name: "Claude Opus 4.7",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1_000_000,
              maxTokens: 64_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
              },
            },
            {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1_000_000,
              maxTokens: 64_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
              },
            },
          ],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 272_000,
              maxTokens: 128_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              mediaInput: {
                image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
              },
            },
          ],
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

  it.each([{ label: "static catalog", runtimeAugment: false, staticMaxSidePx: undefined }])(
    "keeps image policy pinned to the prepared generation: $label",
    async ({ runtimeAugment }) => {
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
          runtimeAugment,
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
          runtimeAugment,
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
    },
  );

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
                  Object.assign(makeModelDefinition(id, ["text", "image"]), {
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
                preparedModelRuntime: captured.preparedModelRuntime,
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
