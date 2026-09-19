// Covers the extractStructuredWithModel runtime seam: provider-hook routing,
// timeout capping, input guards, and the generic model-backed fallback.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { extractStructuredWithModel } from "./runtime.js";
import type { MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  createMediaAttachmentCache: vi.fn(),
  normalizeMediaAttachments: vi.fn(() => []),
  runCapability: vi.fn(),
  normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  getMediaUnderstandingProvider: vi.fn(),
  describeImageWithModel: vi.fn(),
  convertHeicToJpeg: vi.fn(),
  extractStructuredWithModelFallback: vi.fn<
    (req: Record<string, unknown>) => Promise<Record<string, unknown>>
  >(async () => ({
    text: '{"ok":true}',
    parsed: { ok: true },
    model: "fallback-model",
    provider: "fallback",
    contentType: "json" as const,
  })),
}));

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

vi.mock("./structured-runtime.js", () => ({
  extractStructuredWithModelFallback: mocks.extractStructuredWithModelFallback,
}));

describe("extractStructuredWithModel", () => {
  afterEach(() => {
    mocks.buildMediaUnderstandingRegistry.mockReset();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
    mocks.getMediaUnderstandingProvider.mockReset();
    mocks.extractStructuredWithModelFallback.mockReset();
    mocks.extractStructuredWithModelFallback.mockResolvedValue({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "fallback-model",
      provider: "fallback",
      contentType: "json",
    });
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
});
