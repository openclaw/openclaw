import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) {
      return auth.apiKey;
    }
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
  resolveAwsSdkEnvVarName: vi.fn(() => undefined),
  resolveEnvApiKey: vi.fn(() => null),
  resolveModelAuthMode: vi.fn(() => "api-key"),
  getApiKeyForModel: vi.fn(async () => ({ apiKey: "test-key", source: "test", mode: "api-key" })),
  getCustomProviderApiKey: vi.fn(() => undefined),
  ensureAuthProfileStore: vi.fn(async () => ({})),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

class MediaFetchErrorMock extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "MediaFetchError";
    this.code = code;
  }
}

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(),
  MediaFetchError: MediaFetchErrorMock,
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

const mockDeliverOutboundPayloads = vi.fn();

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;
let clearMediaUnderstandingBinaryCacheForTests: () => void;

const TEMP_MEDIA_PREFIX = "openclaw-echo-transcript-test-";
let suiteTempMediaRootDir = "";

async function createTempAudioFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "case-"));
  const filePath = path.join(dir, "note.ogg");
  await fs.writeFile(filePath, Buffer.from([0, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
  return filePath;
}

function createAudioCtxWithProvider(mediaPath: string, extra?: Partial<MsgContext>): MsgContext {
  return {
    Body: "<media:audio>",
    MediaPath: mediaPath,
    MediaType: "audio/ogg",
    Provider: "whatsapp",
    From: "+10000000001",
    AccountId: "acc1",
    ...extra,
  };
}

function createAudioConfigWithEcho(opts?: {
  echoTranscript?: boolean;
  echoFormat?: string;
  transcribedText?: string;
}): {
  cfg: OpenClawConfig;
  providers: Record<string, { id: string; transcribeAudio: () => Promise<{ text: string }> }>;
} {
  const cfg: OpenClawConfig = {
    tools: {
      media: {
        audio: {
          enabled: true,
          maxBytes: 1024 * 1024,
          models: [{ provider: "groq" }],
          echoTranscript: opts?.echoTranscript ?? true,
          ...(opts?.echoFormat !== undefined ? { echoFormat: opts.echoFormat } : {}),
        },
      },
    },
  };
  const providers = {
    groq: {
      id: "groq",
      transcribeAudio: async () => ({ text: opts?.transcribedText ?? "hello world" }),
    },
  };
  return { cfg, providers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyMediaUnderstanding – echo transcript", () => {
  beforeAll(async () => {
    const baseDir = resolvePreferredOpenClawTmpDir();
    await fs.mkdir(baseDir, { recursive: true });
    suiteTempMediaRootDir = await fs.mkdtemp(path.join(baseDir, TEMP_MEDIA_PREFIX));
    const mod = await import("./apply.js");
    applyMediaUnderstanding = mod.applyMediaUnderstanding;
    const runner = await import("./runner.js");
    clearMediaUnderstandingBinaryCacheForTests = runner.clearMediaUnderstandingBinaryCacheForTests;
  });

  beforeEach(() => {
    mockDeliverOutboundPayloads.mockClear();
    mockDeliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "echo-1" }]);
    clearMediaUnderstandingBinaryCacheForTests?.();
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
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: false });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when echoTranscript is absent (default)", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 1024 * 1024,
            models: [{ provider: "groq" }],
            // echoTranscript not set → defaults to false
          },
        },
      },
    };
    const providers = {
      groq: { id: "groq", transcribeAudio: async () => ({ text: "hello world" }) },
    };

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("echoes transcript with default format when echoTranscript is true", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      transcribedText: "hello world",
    });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    const callArgs = mockDeliverOutboundPayloads.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs.channel).toBe("whatsapp");
    expect(callArgs.to).toBe("+10000000001");
    expect(callArgs.accountId).toBe("acc1");
    expect(callArgs.payloads).toHaveLength(1);
    expect(callArgs.payloads[0].text).toBe('📝 "hello world"');
  });

  it("uses custom echoFormat when provided", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({
      echoTranscript: true,
      echoFormat: "🎙️ Heard: {transcript}",
      transcribedText: "custom message",
    });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    const callArgs = mockDeliverOutboundPayloads.mock.calls[0]?.[0];
    expect(callArgs?.payloads[0].text).toBe("🎙️ Heard: custom message");
  });

  it("does NOT echo when there are no audio attachments", async () => {
    // Image-only context — no audio attachment
    const dir = await fs.mkdtemp(path.join(suiteTempMediaRootDir, "img-"));
    const imgPath = path.join(dir, "photo.jpg");
    await fs.writeFile(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const ctx: MsgContext = {
      Body: "<media:image>",
      MediaPath: imgPath,
      MediaType: "image/jpeg",
      Provider: "whatsapp",
      From: "+10000000001",
    };

    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 1024 * 1024,
            models: [{ provider: "groq" }],
            echoTranscript: true,
          },
          image: { enabled: false },
        },
      },
    };
    const providers = {
      groq: { id: "groq", transcribeAudio: async () => ({ text: "should not appear" }) },
    };

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // No audio outputs → Transcript not set → no echo
    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when transcription fails", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: {
            enabled: true,
            maxBytes: 1024 * 1024,
            models: [{ provider: "groq" }],
            echoTranscript: true,
          },
        },
      },
    };
    const providers = {
      groq: {
        id: "groq",
        transcribeAudio: async () => {
          throw new Error("transcription provider failure");
        },
      },
    };

    // Should not throw; transcription failure is swallowed by runner
    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(ctx.Transcript).toBeUndefined();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when channel is not deliverable", async () => {
    const mediaPath = await createTempAudioFile();
    // Use an internal/non-deliverable channel
    const ctx = createAudioCtxWithProvider(mediaPath, {
      Provider: "internal-system",
      From: "some-source",
    });
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    // Transcript should be set (transcription succeeded)
    expect(ctx.Transcript).toBe("hello world");
    // But echo should be skipped
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does NOT echo when ctx has no From or OriginatingTo", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: mediaPath,
      MediaType: "audio/ogg",
      Provider: "whatsapp",
      // From and OriginatingTo intentionally absent
    };
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(ctx.Transcript).toBe("hello world");
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("uses OriginatingTo when From is absent", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx: MsgContext = {
      Body: "<media:audio>",
      MediaPath: mediaPath,
      MediaType: "audio/ogg",
      Provider: "whatsapp",
      OriginatingTo: "+19999999999",
    };
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    await applyMediaUnderstanding({ ctx, cfg, providers });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    const callArgs = mockDeliverOutboundPayloads.mock.calls[0]?.[0];
    expect(callArgs?.to).toBe("+19999999999");
  });

  it("echo delivery failure does not throw or break transcription", async () => {
    const mediaPath = await createTempAudioFile();
    const ctx = createAudioCtxWithProvider(mediaPath);
    const { cfg, providers } = createAudioConfigWithEcho({ echoTranscript: true });

    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));

    // Should not throw
    const result = await applyMediaUnderstanding({ ctx, cfg, providers });

    // Transcription itself succeeded
    expect(result.appliedAudio).toBe(true);
    expect(ctx.Transcript).toBe("hello world");
    // Deliver was attempted
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
  });
});
