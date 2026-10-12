// Media-understanding runtime tests cover file APIs, provider dispatch, disabled
// state, cleanup, remote references, and direct model-backed image calls.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  describeVideoFile,
  describeImageFile,
  describeImageFileWithModel,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
  transcribeAudioFile,
  resolveAudioInputBudget,
} from "./runtime.js";
import type {
  MediaAttachment,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

const mocks = vi.hoisted(() => {
  const cleanup = vi.fn(async () => {});
  const getBuffer = vi.fn(async () => ({
    buffer: Buffer.from("remote-image"),
    fileName: "photo.png",
    mime: "image/png",
    size: 12,
  }));
  return {
    buildProviderRegistry: vi.fn(() => new Map()),
    createMediaAttachmentCache: vi.fn(() => ({ cleanup, getBuffer })),
    normalizeMediaAttachments: vi.fn<() => MediaAttachment[]>(() => []),
    normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
    buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
    getMediaUnderstandingProvider: vi.fn(),
    describeImageWithModel: vi.fn(async () => ({ text: "generic image ok", model: "vision" })),
    convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
    optimizeImageDescriptionInput: vi.fn(
      async (params: { buffer: Buffer; fileName?: string; mime?: string }) => ({
        buffer: Buffer.concat([Buffer.from("optimized:"), params.buffer]),
        fileName: params.fileName,
        mime: params.mime,
      }),
    ),
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

vi.mock("./image-runtime.js", () => ({
  describeImageWithModel: mocks.describeImageWithModel,
}));

vi.mock("../media/media-services.js", () => ({
  convertHeicToJpeg: mocks.convertHeicToJpeg,
}));

vi.mock("./image-input-normalize.js", async () => {
  const actual = await vi.importActual<typeof import("./image-input-normalize.js")>(
    "./image-input-normalize.js",
  );
  return { ...actual, optimizeImageDescriptionInput: mocks.optimizeImageDescriptionInput };
});

function requireRunCapabilityRequest(): unknown {
  // File API tests verify the normalized request handed to runCapability, not
  // just the public return shape.
  const [call] = mocks.runCapability.mock.calls;
  if (!call) {
    throw new Error("expected runCapability call");
  }
  return call[0];
}

const IMAGE_MODEL_DEFAULTS = {
  provider: "zai",
  model: "glm-4.6v",
  prompt: "Describe it",
  cfg: {},
  agentDir: "/tmp/agent",
};

describe("media-understanding runtime", () => {
  afterEach(() => {
    mocks.buildProviderRegistry.mockReset();
    mocks.createMediaAttachmentCache.mockReset();
    mocks.createMediaAttachmentCache.mockReturnValue({
      cleanup: mocks.cleanup,
      getBuffer: mocks.getBuffer,
    });
    mocks.normalizeMediaAttachments.mockReset();
    mocks.normalizeMediaProviderId.mockReset();
    mocks.buildMediaUnderstandingRegistry.mockReset();
    mocks.getMediaUnderstandingProvider.mockReset();
    mocks.describeImageWithModel.mockReset();
    mocks.describeImageWithModel.mockResolvedValue({ text: "generic image ok", model: "vision" });
    mocks.convertHeicToJpeg.mockReset();
    mocks.convertHeicToJpeg.mockResolvedValue(Buffer.from("jpeg-normalized"));
    mocks.optimizeImageDescriptionInput.mockClear();
    mocks.optimizeImageDescriptionInput.mockImplementation(
      async (params: { buffer: Buffer; fileName?: string; mime?: string }) => ({
        buffer: Buffer.concat([Buffer.from("optimized:"), params.buffer]),
        fileName: params.fileName,
        mime: params.mime,
      }),
    );
    mocks.runCapability.mockReset();
    mocks.cleanup.mockReset();
    mocks.cleanup.mockResolvedValue(undefined);
    mocks.getBuffer.mockReset();
    mocks.getBuffer.mockResolvedValue({
      buffer: Buffer.from("remote-image"),
      fileName: "photo.png",
      mime: "image/png",
      size: 12,
    });
  });

  it("returns disabled state without loading providers", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);

    await expect(
      runMediaUnderstandingFile({
        capability: "image",
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
        cfg: {
          tools: {
            media: {
              image: {
                enabled: false,
              },
            },
          },
        } as OpenClawConfig,
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

  it("resolves the agent directory for agent-scoped file media", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.ogg", mime: "audio/ogg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    });

    await runMediaUnderstandingFile({
      capability: "audio",
      filePath: "/tmp/sample.ogg",
      mime: "audio/ogg",
      cfg: {
        agents: { entries: { worker: { agentDir: "/tmp/worker-agent" } } },
      } as OpenClawConfig,
      agentId: "worker",
    });

    expect(mocks.runCapability).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", agentDir: "/tmp/worker-agent" }),
    );
  });

  it("passes media scope context through file media understanding requests", async () => {
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "image ok",
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    await describeImageFile({
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      cfg: {} as OpenClawConfig,
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

  it("passes image file URLs as remote media understanding inputs", async () => {
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "image ok",
    };
    const media = [{ index: 0, url: "https://example.com/photo.png", mime: "image/png" }];
    mocks.normalizeMediaAttachments.mockReturnValue(media);
    mocks.runCapability.mockResolvedValue({ outputs: [output] });

    await describeImageFile({
      filePath: "https://example.com/photo.png",
      mediaUrl: "https://example.com/photo.png",
      mime: "image/png",
      cfg: {} as OpenClawConfig,
      agentDir: "/tmp/agent",
    });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ url: "https://example.com/photo.png", contentType: "image/png" }],
    });
    expect(requireRunCapabilityRequest()).toMatchObject({
      ctx: {
        media: [{ url: "https://example.com/photo.png", contentType: "image/png" }],
      },
      media,
    });
  });

  it("passes workspaceDir through audio and video file helpers", async () => {
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: { capability: "video", outcome: "skipped", attachments: [] },
    });
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.mp4", mime: "video/mp4" },
    ]);

    await describeVideoFile({
      filePath: "/tmp/sample.mp4",
      mime: "video/mp4",
      cfg: {} as OpenClawConfig,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(requireRunCapabilityRequest()).toMatchObject({
      capability: "video",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    mocks.runCapability.mockReset();
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    });
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.ogg", mime: "audio/ogg" },
    ]);

    await transcribeAudioFile({
      filePath: "/tmp/sample.ogg",
      mime: "audio/ogg",
      cfg: {} as OpenClawConfig,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(requireRunCapabilityRequest()).toMatchObject({
      capability: "audio",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("passes per-request image prompts into media understanding config", async () => {
    const media = [{ index: 0, path: "/tmp/sample.jpg", mime: "image/jpeg" }];
    const providerRegistry = new Map();
    const cache = { cleanup: mocks.cleanup, getBuffer: mocks.getBuffer };
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "button count ok",
    };
    mocks.buildProviderRegistry.mockReturnValue(providerRegistry);
    mocks.createMediaAttachmentCache.mockReturnValue(cache);
    mocks.normalizeMediaAttachments.mockReturnValue(media);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    const cfg = {
      tools: {
        media: {
          image: {
            prompt: "default image prompt",
          },
        },
      },
    } as OpenClawConfig;

    await describeImageFile({
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      cfg,
      agentDir: "/tmp/agent",
      prompt: "Count visible buttons",
      timeoutMs: 90_000,
    });

    expect(mocks.runCapability).toHaveBeenCalledOnce();
    expect(requireRunCapabilityRequest()).toMatchObject({
      capability: "image",
      cfg,
      request: { prompt: "Count visible buttons" },
      ctx: {
        media: [{ path: "/tmp/sample.jpg", contentType: "image/jpeg" }],
      },
      attachments: cache,
      media,
      agentDir: "/tmp/agent",
      providerRegistry,
      config: {
        prompt: "Count visible buttons",
        timeoutSeconds: 90,
      },
      activeModel: undefined,
    });
  });

  it.each([
    {
      name: "HEIF sequence",
      mime: "image/heif-sequence",
      bytes: Buffer.from("00000018667479706d736631000000000000000000000000", "hex"),
    },
  ])(
    "normalizes local $name explicit image descriptions before provider execution",
    async (testCase) => {
      mocks.getBuffer.mockResolvedValue({
        buffer: testCase.bytes,
        fileName: "sample.bin",
        mime: testCase.mime,
        size: testCase.bytes.length,
      });

      await describeImageFileWithModel({
        ...IMAGE_MODEL_DEFAULTS,
        filePath: "/tmp/sample.bin",
        mime: testCase.mime,
      });

      expect(mocks.convertHeicToJpeg).toHaveBeenCalledWith(testCase.bytes);
      expect(mocks.describeImageWithModel).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: Buffer.from("optimized:jpeg-normalized"),
          fileName: "sample.bin",
          mime: "image/jpeg",
        }),
      );
    },
  );

  it("fetches remote explicit image descriptions through the media attachment cache", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, url: "https://httpbin.org/image/png", mime: "image/png" },
    ]);
    mocks.buildProviderRegistry.mockReturnValue(
      new Map([["zai", { id: "zai", capabilities: ["image"] }]]),
    );
    mocks.getBuffer.mockResolvedValue({
      buffer: Buffer.from("remote-png"),
      fileName: "png",
      mime: "image/png",
      size: 10,
    });

    await expect(
      describeImageFileWithModel({
        ...IMAGE_MODEL_DEFAULTS,
        filePath: "https://httpbin.org/image/png",
        timeoutMs: 45_000,
      }),
    ).resolves.toEqual({ text: "generic image ok", model: "vision" });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ url: "https://httpbin.org/image/png", contentType: "image/*" }],
    });
    expect(mocks.createMediaAttachmentCache).toHaveBeenCalledWith(
      [{ index: 0, url: "https://httpbin.org/image/png", mime: "image/png" }],
      { localPathRoots: undefined, ssrfPolicy: undefined },
    );
    expect(mocks.getBuffer).toHaveBeenCalledWith({
      attachmentIndex: 0,
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 45_000,
    });
    expect(mocks.describeImageWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.from("optimized:remote-png"),
        fileName: "png",
        mime: "image/png",
        provider: "zai",
        model: "glm-4.6v",
      }),
    );
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("caps explicit image description timeouts before fetch and provider execution", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, url: "https://example.com/photo.png", mime: "image/png" },
    ]);

    await describeImageFileWithModel({
      ...IMAGE_MODEL_DEFAULTS,
      filePath: "https://example.com/photo.png",
      mediaUrl: "https://example.com/photo.png",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(mocks.getBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
    );
    expect(mocks.describeImageWithModel).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
    );
  });

  it("resolves the agent directory when direct image description only names an agent", async () => {
    mocks.getBuffer.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      fileName: "sample.jpg",
      mime: "image/jpeg",
      size: 11,
    });

    await describeImageFileWithModel({
      ...IMAGE_MODEL_DEFAULTS,
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      provider: "gemini",
      model: "vision-v1",
      prompt: "Describe the sample.",
      cfg: {
        agents: { entries: { worker: { agentDir: "/tmp/worker-agent" } } },
      } as OpenClawConfig,
      agentId: "worker",
      agentDir: undefined,
    });

    expect(mocks.describeImageWithModel).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", agentDir: "/tmp/worker-agent" }),
    );
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

    await extractStructuredWithModel({
      input: [
        {
          type: "image",
          buffer: Buffer.from("image-bytes"),
          fileName: "fact.png",
          mime: "image/png",
        },
      ],
      instructions: "Return JSON.",
      provider: "vision-plugin",
      model: "vision-json",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      cfg: {} as OpenClawConfig,
    });

    expect(extractStructured).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
    );
  });

  it("rejects text-only structured extraction before provider lookup", async () => {
    await expect(
      extractStructuredWithModel({
        input: [{ type: "text", text: "Extract the fact." }],
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Structured extraction requires at least one image input.");

    expect(mocks.buildMediaUnderstandingRegistry).not.toHaveBeenCalled();
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("fails clearly when a provider lacks structured extraction", async () => {
    const providerRegistry = new Map();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(providerRegistry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin" });

    await expect(
      extractStructuredWithModel({
        input: [
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Provider does not support structured extraction: vision-plugin");
  });

  it("surfaces the underlying provider failure when media understanding fails", async () => {
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.ogg", mime: "audio/ogg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: {
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                outcome: "failed",
                reason: "Error: Audio transcription response missing text",
              },
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
        agentDir: "/tmp/agent",
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

  it.each([
    {
      name: "automatic input override",
      cfg: { tools: { media: { audio: { maxBytes: 4096 } } } },
      maxBytes: 4096,
    },
    {
      name: "local CLI inheriting audio input limit",
      cfg: {
        tools: {
          media: {
            audio: { maxBytes: 4096 },
            models: [{ type: "cli", command: "fixture-asr", capabilities: ["audio"] }],
          },
        },
      },
      maxBytes: 4096,
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; maxBytes: number }>)(
    "prepares the existing transcription input budget for $name",
    async ({ cfg, maxBytes }) => {
      mocks.buildProviderRegistry.mockReturnValue(
        new Map([["registered-audio", { capabilities: ["audio"] }]]),
      );
      await expect(resolveAudioInputBudget({ cfg })).resolves.toEqual({ enabled: true, maxBytes });
      expect(mocks.runCapability).not.toHaveBeenCalled();
    },
  );

  it("does not load providers to prepare disabled audio input", async () => {
    await expect(
      resolveAudioInputBudget({ cfg: { tools: { media: { audio: { enabled: false } } } } }),
    ).resolves.toEqual({ enabled: false });
    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
  });
});
