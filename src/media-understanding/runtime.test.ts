import { expectDefined } from "@openclaw/normalization-core/expect";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  describeVideoFile,
  describeImageFile,
  describeImageFileWithModel,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
  transcribeAudioFile,
  resolveAudioInputBudget,
} from "./runtime.js";
import type { MediaAttachment, MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => {
  const remoteImage = {
    buffer: Buffer.from("remote-image"),
    fileName: "photo.png",
    mime: "image/png",
    size: 12,
  };
  const optimize = async (params: { buffer: Buffer; fileName?: string; mime?: string }) => ({
    buffer: Buffer.concat([Buffer.from("optimized:"), params.buffer]),
    fileName: params.fileName,
    mime: params.mime,
  });
  const cleanup = vi.fn(async () => {});
  const getBuffer = vi.fn(async () => remoteImage);
  return {
    buildProviderRegistry: vi.fn(() => new Map()),
    createMediaAttachmentCache: vi.fn(() => ({ cleanup, getBuffer })),
    normalizeMediaAttachments: vi.fn<() => MediaAttachment[]>(() => []),
    normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
    buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
    getMediaUnderstandingProvider: vi.fn(),
    describeImageWithModel: vi.fn(async () => ({ text: "generic image ok", model: "vision" })),
    convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
    optimizeImageDescriptionInput: vi.fn(optimize),
    defaults: { remoteImage, optimize },
    runCapability: vi.fn(),
    cleanup,
    getBuffer,
  };
});

vi.mock("./runner.js", () => ({
  buildProviderRegistry: mocks.buildProviderRegistry,
  createMediaAttachmentCache: mocks.createMediaAttachmentCache,
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  runCapability: mocks.runCapability,
}));

vi.mock("./provider-registry.js", () => ({
  normalizeMediaProviderId: mocks.normalizeMediaProviderId,
  buildMediaUnderstandingRegistry: mocks.buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider: mocks.getMediaUnderstandingProvider,
}));

vi.mock("./image-runtime.js", () => ({ describeImageWithModel: mocks.describeImageWithModel }));

vi.mock("../media/media-services.js", () => ({ convertHeicToJpeg: mocks.convertHeicToJpeg }));

vi.mock("./image-input-normalize.js", async () => {
  const actual = await vi.importActual<typeof import("./image-input-normalize.js")>(
    "./image-input-normalize.js",
  );
  return { ...actual, optimizeImageDescriptionInput: mocks.optimizeImageDescriptionInput };
});

function requireRunCapabilityRequest(): unknown {
  return expectDefined(mocks.runCapability.mock.calls[0], "runCapability call")[0];
}
function stubMedia(filePath: string, mime: string, withOutput = false) {
  const media = [
    { index: 0, mime, ...(filePath.startsWith("https:") ? { url: filePath } : { path: filePath }) },
  ];
  mocks.normalizeMediaAttachments.mockReturnValue(media);
  if (withOutput) {
    mocks.runCapability.mockResolvedValue({
      outputs: [
        { kind: "image.description", attachmentIndex: 0, provider: "x", model: "x", text: "ok" },
      ],
    });
  }
  return media;
}
function stubBuffer(buffer: Buffer, fileName: string, mime: string) {
  mocks.getBuffer.mockResolvedValue({ buffer, fileName, mime, size: buffer.length });
}
function describeModel(
  filePath: string,
  overrides: Partial<Parameters<typeof describeImageFileWithModel>[0]> = {},
) {
  return describeImageFileWithModel({ ...IMAGE_MODEL_DEFAULTS, filePath, ...overrides });
}
function expectImageRequest(expected: object) {
  expect(mocks.describeImageWithModel).toHaveBeenCalledWith(expect.objectContaining(expected));
}

const localImage = { filePath: "/tmp/sample.jpg", mime: "image/jpeg", cfg: {} };
const structuredDefaults = {
  input: [
    {
      type: "image" as const,
      buffer: Buffer.from("image-bytes"),
      fileName: "fact.png",
      mime: "image/png",
    },
  ],
  instructions: "Return JSON.",
  provider: "vision-plugin",
  model: "vision-json",
  cfg: {},
};

const IMAGE_MODEL_DEFAULTS = {
  provider: "zai",
  model: "glm-4.6v",
  prompt: "Describe it",
  cfg: {},
  agentDir: "/tmp/agent",
};

describe("media-understanding runtime", () => {
  afterEach(() => {
    const { defaults, ...resettable } = mocks;
    for (const mock of Object.values(resettable)) {
      mock.mockReset();
    }
    mocks.createMediaAttachmentCache.mockReturnValue({
      cleanup: mocks.cleanup,
      getBuffer: mocks.getBuffer,
    });
    mocks.describeImageWithModel.mockResolvedValue({ text: "generic image ok", model: "vision" });
    mocks.convertHeicToJpeg.mockResolvedValue(Buffer.from("jpeg-normalized"));
    mocks.optimizeImageDescriptionInput.mockImplementation(defaults.optimize);
    mocks.cleanup.mockResolvedValue(undefined);
    mocks.getBuffer.mockResolvedValue(defaults.remoteImage);
  });

  it("returns disabled state without loading providers", async () => {
    stubMedia("/tmp/sample.jpg", "image/jpeg");

    await expect(
      runMediaUnderstandingFile({
        capability: "image",
        ...localImage,
        cfg: { tools: { media: { image: { enabled: false } } } },
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
      decision: {
        capability: "image",
        outcome: "disabled",
        attachments: [],
        attachmentDispositions: { 0: { kind: "capability-disabled" } },
        attachmentProcessing: { 0: "omitted" },
        nativeVisionActive: false,
      },
    });

    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
    expect(mocks.runCapability).not.toHaveBeenCalled();
  });

  it("passes media scope context through file media understanding requests", async () => {
    stubMedia("/tmp/sample.jpg", "image/jpeg", true);

    await describeImageFile({
      ...localImage,
      scopeContext: {
        sessionKey: "agent:main:telegram:dm:123",
        channel: "telegram",
        chatType: "private",
      },
    });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ path: "/tmp/sample.jpg", contentType: "image/jpeg" }],
      SessionKey: "agent:main:telegram:dm:123",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "private",
    });
    expect(requireRunCapabilityRequest()).toMatchObject({
      ctx: {
        SessionKey: "agent:main:telegram:dm:123",
        Surface: "telegram",
        ChatType: "private",
      },
    });
  });

  it.each([
    { capability: "video", filePath: "/tmp/sample.mp4", mime: "video/mp4", run: describeVideoFile },
    {
      capability: "audio",
      filePath: "/tmp/sample.ogg",
      mime: "audio/ogg",
      run: transcribeAudioFile,
    },
  ] as const)(
    "passes workspaceDir through $capability file helpers",
    async ({ capability, filePath, mime, run }) => {
      mocks.runCapability.mockResolvedValue({
        outputs: [],
        decision: { capability, outcome: "skipped", attachments: [] },
      });
      mocks.normalizeMediaAttachments.mockReturnValue([{ index: 0, path: filePath, mime }]);
      await run({
        filePath,
        mime,
        cfg: {},
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
      });
      expect(requireRunCapabilityRequest()).toMatchObject({
        capability,
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
      });
    },
  );

  it("passes per-request image prompts into media understanding config", async () => {
    const media = stubMedia("https://example.com/photo.png", "image/png", true);
    const providerRegistry = new Map();
    const cache = { cleanup: mocks.cleanup, getBuffer: mocks.getBuffer };
    mocks.buildProviderRegistry.mockReturnValue(providerRegistry);
    mocks.createMediaAttachmentCache.mockReturnValue(cache);

    const cfg = {
      agents: { entries: { worker: { agentDir: "/tmp/worker-agent" } } },
      tools: { media: { image: { prompt: "default image prompt" } } },
    } as OpenClawConfig;

    await describeImageFile({
      filePath: "https://example.com/photo.png",
      mediaUrl: "https://example.com/photo.png",
      mime: "image/png",
      cfg,
      agentId: "worker",
      prompt: "Count visible buttons",
      timeoutMs: 90_000,
    });

    expect(mocks.runCapability).toHaveBeenCalledOnce();
    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ url: "https://example.com/photo.png", contentType: "image/png" }],
    });
    expect(requireRunCapabilityRequest()).toMatchObject({
      capability: "image",
      cfg,
      request: { prompt: "Count visible buttons" },
      ctx: { media: [{ url: "https://example.com/photo.png", contentType: "image/png" }] },
      attachments: cache,
      media,
      agentId: "worker",
      agentDir: "/tmp/worker-agent",
      providerRegistry,
      config: { prompt: "Count visible buttons", timeoutSeconds: 90 },
      activeModel: undefined,
    });
  });

  it("normalizes local HEIF sequence descriptions before provider execution", async () => {
    const bytes = Buffer.from("00000018667479706d736631000000000000000000000000", "hex");
    stubBuffer(bytes, "sample.bin", "image/heif-sequence");
    await describeModel("/tmp/sample.bin", {
      mime: "image/heif-sequence",
      cfg: { agents: { entries: { worker: { agentDir: "/tmp/worker-agent" } } } },
      agentId: "worker",
      agentDir: undefined,
    });
    expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(bytes);
    expectImageRequest({
      buffer: Buffer.from("optimized:jpeg-normalized"),
      fileName: "sample.bin",
      mime: "image/jpeg",
      agentId: "worker",
      agentDir: "/tmp/worker-agent",
    });
  });

  it("fetches remote explicit image descriptions through the attachment cache", async () => {
    const filePath = "https://httpbin.org/image/png";
    const media = stubMedia(filePath, "image/png");
    stubBuffer(Buffer.from("remote-png"), "png", "image/png");
    await expect(describeModel(filePath, { timeoutMs: 45_000 })).resolves.toEqual({
      text: "generic image ok",
      model: "vision",
    });
    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ url: filePath, contentType: "image/*" }],
    });
    expect(mocks.createMediaAttachmentCache).toHaveBeenCalledWith(media, {
      localPathRoots: undefined,
      ssrfPolicy: undefined,
    });
    expect(mocks.getBuffer).toHaveBeenCalledWith({
      attachmentIndex: 0,
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 45_000,
    });
    expectImageRequest({
      buffer: Buffer.from("optimized:remote-png"),
      fileName: "png",
      mime: "image/png",
      provider: "zai",
      model: "glm-4.6v",
    });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("caps explicit image timeouts before fetch and provider execution", async () => {
    const filePath = "https://example.com/photo.png";
    stubMedia(filePath, "image/png");
    await describeModel(filePath, { mediaUrl: filePath, timeoutMs: Number.MAX_SAFE_INTEGER });
    expect(mocks.getBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
    );
    expectImageRequest({ timeoutMs: MAX_TIMER_TIMEOUT_MS });
  });

  it("caps explicit structured extraction timeouts before provider execution", async () => {
    const extractStructured = vi.fn<NonNullable<MediaUnderstandingProvider["extractStructured"]>>(
      async () => ({
        text: "{}",
        parsed: {},
        model: "vision-json",
        provider: "vision-plugin",
        contentType: "json" as const,
      }),
    );
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin", extractStructured });

    await extractStructuredWithModel({ ...structuredDefaults, timeoutMs: Number.MAX_SAFE_INTEGER });

    expect(extractStructured).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
    );
  });

  it("rejects text-only structured extraction before provider lookup", async () => {
    await expect(
      extractStructuredWithModel({
        ...structuredDefaults,
        input: [{ type: "text", text: "Extract the fact." }],
      }),
    ).rejects.toThrow("Structured extraction requires at least one image input.");

    expect(mocks.buildMediaUnderstandingRegistry).not.toHaveBeenCalled();
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("fails clearly when a provider lacks structured extraction", async () => {
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin" });

    await expect(extractStructuredWithModel(structuredDefaults)).rejects.toThrow(
      "Provider does not support structured extraction: vision-plugin",
    );
  });

  it("surfaces the underlying provider failure when media understanding fails", async () => {
    stubMedia("/tmp/sample.ogg", "audio/ogg");
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: {
        outcome: "failed",
        attachments: [
          {
            attempts: [
              { outcome: "failed", reason: "Error: Audio transcription response missing text" },
            ],
          },
        ],
      },
    });

    await expect(
      runMediaUnderstandingFile({
        capability: "audio",
        filePath: "/tmp/sample.ogg",
        mime: "audio/ogg",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Audio transcription response missing text");

    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("media-understanding audio input budget", () => {
  afterEach(() => {
    mocks.buildProviderRegistry.mockReset();
    mocks.runCapability.mockReset();
  });

  it.each([false, true])("prepares audio input budget with a CLI entry: %s", async (local) => {
    const models: MediaUnderstandingModelConfig[] = [
      { type: "cli", command: "fixture-asr", capabilities: ["audio"] },
    ];
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: { maxBytes: 4096 },
          ...(local ? { models } : {}),
        },
      },
    };
    mocks.buildProviderRegistry.mockReturnValue(
      new Map([["registered-audio", { capabilities: ["audio"] }]]),
    );
    await expect(resolveAudioInputBudget({ cfg })).resolves.toEqual({
      enabled: true,
      maxBytes: 4096,
    });
    expect(mocks.runCapability).not.toHaveBeenCalled();
  });

  it("does not load providers to prepare disabled audio input", async () => {
    await expect(
      resolveAudioInputBudget({ cfg: { tools: { media: { audio: { enabled: false } } } } }),
    ).resolves.toEqual({ enabled: false });
    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
  });
});
