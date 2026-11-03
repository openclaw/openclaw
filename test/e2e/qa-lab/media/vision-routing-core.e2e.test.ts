import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../../src/auto-reply/media-note.js";
import { resolveCurrentTurnImages } from "../../../../src/auto-reply/reply/current-turn-images.js";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import type { ModelProviderConfig } from "../../../../src/config/types.models.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import type { MediaUnderstandingProvider } from "../../../../src/media-understanding/types.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const ACTIVE_PROVIDER = "openai";
const ACTIVE_VISION_MODEL = "gpt-4.1";
const PRIMARY_PROVIDER = "qa-vision-primary";
const PRIMARY_MODEL = "primary-vision";
const FALLBACK_PROVIDER = "qa-vision-fallback";
const FALLBACK_MODEL = "fallback-vision";
const SUMMARY_TEXT = "QA_VISION_FALLBACK_SUMMARY";

const preparedVisionCatalog = vi.hoisted(() => [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
]);

vi.mock("../../../../src/agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => preparedVisionCatalog),
}));

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

vi.mock("../../../../src/media-understanding/image-runtime.js", () => ({
  describeImageWithModel: vi.fn(),
  describeImagesWithModel: vi.fn(),
}));

function createImageContext(imagePath: string, workspaceDir: string): MsgContext {
  const body = "describe the attached image";
  const media = [
    { path: imagePath, contentType: "image/png", kind: "image" as const, workspaceDir },
  ];
  return { Body: body, CommandBody: body, RawBody: body, media };
}

function configuredProvider(model: string): ModelProviderConfig {
  return {
    apiKey: "test-key", // pragma: allowlist secret
    baseUrl: "https://example.invalid/v1",
    models: [
      {
        id: model,
        name: model,
        input: ["text", "image"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  };
}

describe("core vision routing product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function routeImage(native: boolean) {
    const workspaceDir = tempDirs.make("openclaw-vision-");
    const imagePath = path.join(workspaceDir, "image.png");
    const imageBytes = createSolidPngBuffer(2, 2, { r: 24, g: 96, b: 208 });
    await fs.writeFile(imagePath, imageBytes);
    const ctx = createImageContext(imagePath, workspaceDir);
    const providerCalls: string[] = [];
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          [native ? ACTIVE_PROVIDER : PRIMARY_PROVIDER]: configuredProvider(
            native ? ACTIVE_VISION_MODEL : PRIMARY_MODEL,
          ),
          [FALLBACK_PROVIDER]: configuredProvider(FALLBACK_MODEL),
        },
      },
    };
    if (native) {
      cfg.agents = {
        defaults: { imageModel: { primary: `${FALLBACK_PROVIDER}/${FALLBACK_MODEL}` } },
      };
    } else {
      cfg.tools = {
        media: {
          models: [
            { provider: PRIMARY_PROVIDER, model: PRIMARY_MODEL, capabilities: ["image"] },
            { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL, capabilities: ["image"] },
          ],
        },
      };
    }
    const providers: Record<string, MediaUnderstandingProvider> = {
      [FALLBACK_PROVIDER]: {
        id: FALLBACK_PROVIDER,
        capabilities: ["image"],
        describeImage: async (request) => {
          providerCalls.push(FALLBACK_PROVIDER);
          return { text: SUMMARY_TEXT, model: request.model };
        },
      },
    };
    if (!native) {
      providers[PRIMARY_PROVIDER] = {
        id: PRIMARY_PROVIDER,
        capabilities: ["image"],
        describeImage: async () => {
          providerCalls.push(PRIMARY_PROVIDER);
          throw new Error("primary vision unavailable");
        },
      };
    }
    await applyMediaUnderstanding({
      ctx,
      cfg,
      agentId: native ? "qa-vision-native" : "qa-vision-fallback",
      agentDir: workspaceDir,
      workspaceDir,
      providers,
      activeModel: native ? { provider: ACTIVE_PROVIDER, model: ACTIVE_VISION_MODEL } : undefined,
    });
    return { ctx, cfg, imageBytes, imagePath, providerCalls };
  }

  it("bypasses summarization and sends the real image to an active vision model", async () => {
    const { ctx, cfg, imageBytes, providerCalls } = await routeImage(true);
    expect(ctx.MediaUnderstanding).toBeUndefined();
    expect(providerCalls).toEqual([]);
    expect(ctx.Body).not.toContain(SUMMARY_TEXT);
    expect(ctx.Body).not.toContain("[Image]");

    const projection = buildInboundMediaNoteProjection(ctx);
    expect(projection.media[0]).not.toHaveProperty("hydrationSuppressed");

    const currentTurnImages = await resolveCurrentTurnImages({ ctx, cfg });
    const data = imageBytes.toString("base64");
    expect(currentTurnImages).toEqual({
      images: [{ type: "image", data, mimeType: "image/png" }],
      imageOrder: ["inline"],
    });
  });

  it("falls back in order, inserts one summary, and suppresses the described raw image", async () => {
    const { ctx, cfg, imagePath, providerCalls } = await routeImage(false);

    expect(providerCalls).toEqual([PRIMARY_PROVIDER, FALLBACK_PROVIDER]);
    expect(ctx.MediaUnderstanding).toEqual([
      {
        kind: "image.description",
        attachmentIndex: 0,
        text: SUMMARY_TEXT,
        provider: FALLBACK_PROVIDER,
        model: FALLBACK_MODEL,
      },
    ]);
    expect((ctx.Body ?? "").split(SUMMARY_TEXT)).toHaveLength(2);

    const projection = buildInboundMediaNoteProjection(ctx);
    expect(projection.media).toEqual([
      expect.objectContaining({
        path: imagePath,
        contentType: "image/png",
        hydrationSuppressed: true,
      }),
    ]);
    await expect(resolveCurrentTurnImages({ ctx, cfg })).resolves.toEqual({});
  });
});
