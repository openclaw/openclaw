// Apply echo-transcript tests cover integrated audio media understanding with
// best-effort transcript delivery.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type ResolveApiKeyForProvider =
  typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore;

const resolveApiKeyForProviderCoreMock = vi.hoisted(() =>
  vi.fn<ResolveApiKeyForProvider>(async () => ({
    apiKey: "test-key", // pragma: allowlist secret
    source: "test",
    mode: "api-key",
  })),
);
const hasAvailableAuthForProviderMock = vi.hoisted(() =>
  vi.fn(async (...args: Parameters<ResolveApiKeyForProvider>) => {
    const resolved = await resolveApiKeyForProviderCoreMock(...args);
    return Boolean(resolved?.apiKey);
  }),
);
const getApiKeyForModelMock = vi.hoisted(() =>
  vi.fn(async () => ({ apiKey: "test-key", source: "test", mode: "api-key" })),
);
const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());
const runExecMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());

const { MediaFetchErrorMock } = vi.hoisted(() => {
  class MediaFetchErrorMockLocal extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "MediaFetchError";
      this.code = code;
    }
  }
  return { MediaFetchErrorMock: MediaFetchErrorMockLocal };
});

let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;

const TEMP_MEDIA_PREFIX = "openclaw-echo-transcript-test-";
let suiteTempMediaRootDir = "";

async function createTempAudioFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "case-"));
  const filePath = path.join(dir, "note.ogg");
  await fs.writeFile(filePath, createSafeAudioFixtureBuffer(2048));
  return filePath;
}

function createAudioCtxWithProvider(mediaPath: string): MsgContext {
  return {
    Body: "<media:audio>",
    media: [{ path: mediaPath, contentType: "audio/ogg" }],
    Provider: "voicechat",
    From: "+10000000001",
    AccountId: "acc1",
  };
}

function createAudioConfigWithEcho(echoTranscript: boolean | undefined) {
  const cfg: OpenClawConfig = {
    tools: {
      media: {
        models: [{ provider: "groq", capabilities: ["audio"] }],
        audio: {
          enabled: true,
          maxBytes: 1024 * 1024,
          ...(echoTranscript === undefined ? {} : { echoTranscript }),
        },
      },
    },
  };
  const providers = {
    groq: {
      id: "groq",
      transcribeAudio: async () => ({ text: "hello world" }),
    },
  };
  return { cfg, providers };
}

function disableImageUnderstanding(cfg: OpenClawConfig): void {
  if (!cfg.tools?.media) {
    throw new Error("Expected media tool config");
  }
  cfg.tools.media.image = { enabled: false };
}

function createRegistryMediaProviders(): Record<string, MediaUnderstandingProvider> {
  const createAudioProvider = (id: string): MediaUnderstandingProvider => ({
    id,
    capabilities: ["audio"],
    transcribeAudio: async () => ({ text: "transcribed text" }),
  });
  return {
    groq: createAudioProvider("groq"),
    deepgram: createAudioProvider("deepgram"),
  };
}

describe("applyMediaUnderstanding – echo transcript", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("../agents/model-auth.js", () => ({
      resolveApiKeyForProviderCore: resolveApiKeyForProviderCoreMock,
      hasAvailableAuthForProvider: hasAvailableAuthForProviderMock,
      isProviderAuthError: (err: unknown, code?: string) =>
        err instanceof Error &&
        "code" in err &&
        (code === undefined || (err as { code?: unknown }).code === code),
      requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
        if (auth?.apiKey) {
          return auth.apiKey;
        }
        const err = new Error(
          `No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`,
        );
        (err as { code?: string; provider?: string }).code = "missing-api-key";
        (err as { code?: string; provider?: string }).provider = provider;
        throw err;
      },
      resolveAwsSdkEnvVarName: vi.fn(() => undefined),
      resolveEnvApiKey: vi.fn(() => null),
      resolveModelAuthMode: vi.fn(() => "api-key"),
      getApiKeyForModelCore: getApiKeyForModelMock,
      getCustomProviderApiKey: vi.fn(() => undefined),
      ensureAuthProfileStore: vi.fn(async () => ({})),
      resolveAuthProfileOrder: vi.fn(() => []),
    }));
    vi.doMock("../media/fetch.js", () => ({
      readRemoteMediaBuffer: readRemoteMediaBufferMock,
      MediaFetchError: MediaFetchErrorMock,
    }));
    vi.doMock("../process/exec.js", () => ({
      runExec: runExecMock,
      runCommandWithTimeout: runCommandWithTimeoutMock,
    }));
    vi.doMock("../channels/message/runtime.js", () => ({
      sendDurableMessageBatchCore: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
    }));
    vi.doMock("../utils/message-channel.js", () => ({
      isDeliverableMessageChannel: (channel: string) => channel === "voicechat",
    }));
    vi.doMock("./provider-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("./provider-registry.js")>("./provider-registry.js");
      const registryProviders = createRegistryMediaProviders();
      return {
        ...actual,
        buildMediaUnderstandingRegistry: (
          overrides?: Record<string, MediaUnderstandingProvider>,
        ) => {
          const registry = new Map<string, MediaUnderstandingProvider>(
            Object.entries(registryProviders),
          );
          for (const [key, provider] of Object.entries(overrides ?? {})) {
            const normalizedKey = actual.normalizeMediaProviderId(key);
            const existing = registry.get(normalizedKey);
            registry.set(
              normalizedKey,
              existing
                ? {
                    ...existing,
                    ...provider,
                    capabilities: provider.capabilities ?? existing.capabilities,
                  }
                : provider,
            );
          }
          return registry;
        },
      };
    });

    const baseDir = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(baseDir, { recursive: true });
    suiteTempMediaRootDir = await fs.mkdtemp(path.join(baseDir, TEMP_MEDIA_PREFIX));
    const mod = await import("./apply.js");
    applyMediaUnderstanding = mod.applyMediaUnderstanding;
  });

  beforeEach(() => {
    resolveApiKeyForProviderCoreMock.mockClear();
    hasAvailableAuthForProviderMock.mockClear();
    getApiKeyForModelMock.mockClear();
    readRemoteMediaBufferMock.mockClear();
    runExecMock.mockReset();
    runCommandWithTimeoutMock.mockReset();
    mockDeliverOutboundPayloads.mockClear();
    mockDeliverOutboundPayloads.mockResolvedValue({
      status: "sent",
      results: [{ channel: "voicechat", messageId: "echo-1" }],
      receipt: { platformMessageIds: ["echo-1"], parts: [], sentAt: 1 },
    });
  });

  afterAll(async () => {
    if (!suiteTempMediaRootDir) {
      return;
    }
    await fs.rm(suiteTempMediaRootDir, { recursive: true, force: true });
    suiteTempMediaRootDir = "";
  });

  it("does NOT echo when echoTranscript is false (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho(false);

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when echoTranscript is absent (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho(undefined);

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("echoes transcript with default format when echoTranscript is true", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho(true);

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "voicechat",
        to: "+10000000001",
        accountId: "acc1",
        payloads: [{ text: '📝 "hello world"' }],
      }),
    );
  });

  it("does NOT echo when there are no audio attachments", async () => {
    // Image-only context — no audio attachment
    const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "img-"));
    const imgPath = path.join(dir, "photo.jpg");
    await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const ctx: MsgContext = {
      Body: "<media:image>",
      media: [{ path: imgPath, contentType: "image/jpeg" }],
      Provider: "voicechat",
      From: "+10000000001",
    };

    const { cfg, providers } = createAudioConfigWithEcho(true);
    disableImageUnderstanding(cfg);

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // No audio outputs → Transcript not set → no echo
    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when transcription fails", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho(true);
    providers.groq.transcribeAudio = async () => {
      throw new Error("transcription provider failure");
    };

    // Should not throw; transcription failure is swallowed by runner
    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
