// Media-understanding runtime tests cover file APIs, provider dispatch, disabled
// state, cleanup, remote references, and direct model-backed image calls.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  describeVideoFile,
  describeImageFile,
  describeImageFileWithModel,
  extractStructuredWithModel,
  runMediaUnderstandingFile,
  transcribeAudioFile,
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
    extractStructuredWithModelFallback: vi.fn<
      (req: Record<string, unknown>) => Promise<Record<string, unknown>>
    >(async () => ({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "fallback-model",
      provider: "fallback",
      contentType: "json" as const,
    })),
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

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

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

vi.mock("./structured-runtime.js", () => ({
  extractStructuredWithModelFallback: mocks.extractStructuredWithModelFallback,
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

  it("preserves skipped decisions when no media provider is available", async () => {
    const decision = {
      capability: "audio" as const,
      outcome: "skipped" as const,
      attachments: [{ attachmentIndex: 0, attempts: [] }],
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, path: "/tmp/sample.ogg", mime: "audio/ogg" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision,
    });

    await expect(
      runMediaUnderstandingFile({
        capability: "audio",
        filePath: "/tmp/sample.ogg",
        mime: "audio/ogg",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
      decision,
    });

    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
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
        agents: { list: [{ id: "worker", agentDir: "/tmp/worker-agent" }] },
      } as OpenClawConfig,
      agentId: "worker",
    });

    expect(mocks.runCapability).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", agentDir: "/tmp/worker-agent" }),
    );
  });

  it("classifies extensionless remote image URLs before capability filtering", async () => {
    const output: MediaUnderstandingOutput = {
      kind: "image.description",
      attachmentIndex: 0,
      provider: "vision-plugin",
      model: "vision-v1",
      text: "image ok",
    };
    mocks.normalizeMediaAttachments.mockReturnValue([
      { index: 0, url: "https://httpbin.org/image/png", mime: "image/*" },
    ]);
    mocks.runCapability.mockResolvedValue({
      outputs: [output],
    });

    await expect(
      describeImageFile({
        filePath: "https://httpbin.org/image/png",
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: "image ok",
      provider: "vision-plugin",
      model: "vision-v1",
      output,
    });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ url: "https://httpbin.org/image/png", contentType: "image/*" }],
    });
    expect(requireRunCapabilityRequest()).toMatchObject({
      ctx: {
        media: [{ url: "https://httpbin.org/image/png", contentType: "image/*" }],
      },
    });
  });

  it("does not force encoded video URLs into the requested image capability", async () => {
    const mediaUrl = "https://example.com/clip%2Emp4?download=1#preview";
    const media = [{ index: 0, url: mediaUrl, mime: "video/mp4" }];
    mocks.normalizeMediaAttachments.mockReturnValue(media);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: { capability: "image", outcome: "skipped", attachments: [] },
    });

    await expect(
      describeImageFile({
        filePath: mediaUrl,
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toMatchObject({
      text: undefined,
      output: undefined,
    });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [{ url: mediaUrl, contentType: "video/mp4" }],
    });
    expect(requireRunCapabilityRequest()).toMatchObject({
      capability: "image",
      ctx: { media: [{ url: mediaUrl, contentType: "video/mp4" }] },
      media,
    });
  });

  it("passes workspaceDir through file media understanding requests", async () => {
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
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(requireRunCapabilityRequest()).toMatchObject({
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });
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

  it("uses the generic model-backed image runtime for explicit models without media hooks", async () => {
    mocks.getBuffer.mockResolvedValue({
      buffer: Buffer.from("image"),
      fileName: "sample.jpg",
      mime: "image/jpeg",
      size: 5,
    });
    mocks.buildProviderRegistry.mockReturnValue(
      new Map([["zai", { id: "zai", capabilities: ["image"] }]]),
    );

    await expect(
      describeImageFileWithModel({
        ...IMAGE_MODEL_DEFAULTS,
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
      }),
    ).resolves.toEqual({ text: "generic image ok", model: "vision" });

    expect(mocks.describeImageWithModel).toHaveBeenCalledWith({
      buffer: Buffer.from("optimized:image"),
      fileName: "sample.jpg",
      mime: "image/jpeg",
      provider: "zai",
      model: "glm-4.6v",
      prompt: "Describe it",
      maxTokens: undefined,
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/agent",
    });
  });

  it.each([
    {
      name: "HEIC",
      mime: "image/heic; charset=binary",
      bytes: Buffer.from("heic-source"),
    },
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

  it("prefers fetched image MIME over conflicting explicit metadata", async () => {
    mocks.getBuffer.mockResolvedValue({
      buffer: PNG_1X1,
      fileName: "photo.jpg",
      mime: "image/png",
      size: PNG_1X1.length,
    });

    await describeImageFileWithModel({
      ...IMAGE_MODEL_DEFAULTS,
      filePath: "https://example.com/photo.jpg",
      mediaUrl: "https://example.com/photo.jpg",
      mime: "application/pdf",
    });

    expect(mocks.describeImageWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.concat([Buffer.from("optimized:"), PNG_1X1]),
        fileName: "photo.jpg",
        mime: "image/png",
      }),
    );
  });

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

  it("routes direct image description through a provider-specific image hook", async () => {
    const describeImage = vi.fn<NonNullable<MediaUnderstandingProvider["describeImage"]>>(
      async () => ({
        text: "image ok",
        model: "vision-v1",
      }),
    );
    mocks.buildProviderRegistry.mockReturnValue(
      new Map([["gemini", { id: "gemini", capabilities: ["image"], describeImage }]]),
    );
    mocks.getBuffer.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      fileName: "sample.jpg",
      mime: "image/jpeg",
      size: 11,
    });

    await expect(
      describeImageFileWithModel({
        ...IMAGE_MODEL_DEFAULTS,
        filePath: "/tmp/sample.jpg",
        mime: "image/jpeg",
        provider: "gemini",
        model: "vision-v1",
        prompt: "Describe the sample.",
      }),
    ).resolves.toEqual({
      text: "image ok",
      model: "vision-v1",
    });

    expect(mocks.normalizeMediaProviderId).toHaveBeenCalledWith("gemini");
    expect(describeImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        buffer: Buffer.from("optimized:image-bytes"),
        fileName: "sample.jpg",
        mime: "image/jpeg",
        provider: "gemini",
        model: "vision-v1",
        prompt: "Describe the sample.",
        agentDir: "/tmp/agent",
      }),
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
        agents: { list: [{ id: "worker", agentDir: "/tmp/worker-agent" }] },
      } as OpenClawConfig,
      agentId: "worker",
      agentDir: undefined,
    });

    expect(mocks.describeImageWithModel).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", agentDir: "/tmp/worker-agent" }),
    );
  });

  it("routes structured extraction to a provider by id and model", async () => {
    const providerRegistry = new Map();
    const authStore = {} as AuthProfileStore;
    const extractStructured = vi.fn<NonNullable<MediaUnderstandingProvider["extractStructured"]>>(
      async () => ({
        text: '{"ok":true}',
        parsed: { ok: true },
        model: "vision-json",
        provider: "vision-plugin",
        contentType: "json" as const,
      }),
    );
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(providerRegistry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin", extractStructured });

    await expect(
      extractStructuredWithModel({
        input: [
          { type: "text", text: "Extract the fact." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "Vision-Plugin",
        model: "vision-json",
        profile: "work",
        preferredProfile: "preferred-work",
        authStore,
        timeoutMs: 45_000,
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json",
    });

    expect(mocks.buildMediaUnderstandingRegistry).toHaveBeenCalledWith(undefined, {});
    expect(mocks.getMediaUnderstandingProvider).toHaveBeenCalledWith(
      "Vision-Plugin",
      providerRegistry,
    );
    expect(extractStructured).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: [
          { type: "text", text: "Extract the fact." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "Vision-Plugin",
        model: "vision-json",
        profile: "work",
        preferredProfile: "preferred-work",
        timeoutMs: 45_000,
        agentDir: "/tmp/agent",
      }),
    );
    expect(extractStructured.mock.calls[0]?.[0].authStore).toBe(authStore);
    expect(mocks.extractStructuredWithModelFallback).not.toHaveBeenCalled();
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

  it("falls back to model-backed structured extraction when the provider lacks the hook", async () => {
    mocks.extractStructuredWithModelFallback.mockClear();
    const providerRegistry = new Map();
    const authStore = {} as AuthProfileStore;
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
        profile: "work",
        preferredProfile: "preferred-work",
        authStore,
        timeoutMs: 45_000,
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/agent",
      }),
    ).resolves.toEqual({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "fallback-model",
      provider: "fallback",
      contentType: "json",
    });

    expect(mocks.extractStructuredWithModelFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        profile: "work",
        preferredProfile: "preferred-work",
        authStore,
        timeoutMs: 45_000,
        agentDir: "/tmp/agent",
      }),
    );
  });

  it("falls back when no media-understanding provider is registered at all", async () => {
    mocks.extractStructuredWithModelFallback.mockClear();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
    mocks.getMediaUnderstandingProvider.mockReturnValue(undefined);

    const result = await extractStructuredWithModel({
      input: [
        {
          type: "image",
          buffer: Buffer.from("image-bytes"),
          fileName: "fact.png",
          mime: "image/png",
        },
      ],
      instructions: "Return JSON.",
      provider: "anthropic",
      model: "claude-sonnet-5",
      cfg: {} as OpenClawConfig,
      agentDir: "/tmp/agent",
    });

    expect(result.contentType).toBe("json");
    expect(mocks.extractStructuredWithModelFallback).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5" }),
    );
  });

  it("resolves a default agent dir for the fallback when none is supplied", async () => {
    mocks.extractStructuredWithModelFallback.mockClear();
    mocks.getMediaUnderstandingProvider.mockReturnValue(undefined);

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
      provider: "anthropic",
      model: "claude-sonnet-5",
      cfg: {} as OpenClawConfig,
    });

    const call = mocks.extractStructuredWithModelFallback.mock.calls[0]?.[0];
    expect(call?.agentDir).toBeTruthy();
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
