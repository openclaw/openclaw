import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import type { MediaUnderstandingProvider } from "../../../../src/media-understanding/types.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const PRIMARY_PROVIDER = "qa-vision-primary";
const PRIMARY_MODEL = "primary-vision";
const FALLBACK_PROVIDER = "qa-vision-fallback";
const FALLBACK_MODEL = "fallback-vision";
const SUMMARY_TEXT = "QA_VISION_FALLBACK_SUMMARY";

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

describe("core vision routing product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("falls back in order and inserts one image summary", async () => {
    const workspaceDir = tempDirs.make("openclaw-vision-");
    const imagePath = path.join(workspaceDir, "image.png");
    await fs.writeFile(imagePath, createSolidPngBuffer(2, 2, { r: 24, g: 96, b: 208 }));
    const ctx: MsgContext = {
      Body: "describe the attached image",
      media: [{ path: imagePath, contentType: "image/png", kind: "image", workspaceDir }],
    };
    const providerCalls: string[] = [];
    const connection = { apiKey: "test-key", baseUrl: "https://example.invalid/v1", models: [] }; // pragma: allowlist secret
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          [PRIMARY_PROVIDER]: connection,
          [FALLBACK_PROVIDER]: connection,
        },
      },
      tools: {
        media: {
          models: [
            { provider: PRIMARY_PROVIDER, model: PRIMARY_MODEL, capabilities: ["image"] },
            { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL, capabilities: ["image"] },
          ],
        },
      },
    };
    const providers: Record<string, MediaUnderstandingProvider> = {
      [PRIMARY_PROVIDER]: {
        id: PRIMARY_PROVIDER,
        capabilities: ["image"],
        describeImage: async () => {
          providerCalls.push(PRIMARY_PROVIDER);
          throw new Error("primary vision unavailable");
        },
      },
      [FALLBACK_PROVIDER]: {
        id: FALLBACK_PROVIDER,
        capabilities: ["image"],
        describeImage: async (request) => {
          providerCalls.push(FALLBACK_PROVIDER);
          return { text: SUMMARY_TEXT, model: request.model };
        },
      },
    };
    await applyMediaUnderstanding({
      ctx,
      cfg,
      workspaceDir,
      providers,
    });

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
  });
});
