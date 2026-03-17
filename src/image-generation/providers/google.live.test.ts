import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { buildGoogleImageGenerationProvider } from "./google.js";

const LIVE =
  isTruthyEnvValue(process.env.GOOGLE_LIVE_TEST) ||
  isTruthyEnvValue(process.env.LIVE) ||
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim());
const MODEL =
  process.env.GOOGLE_IMAGE_GENERATION_MODEL?.trim() ||
  process.env.GEMINI_IMAGE_GENERATION_MODEL?.trim() ||
  "gemini-3.1-flash-image-preview";
const BASE_URL = process.env.GOOGLE_IMAGE_BASE_URL?.trim();

const describeLive = LIVE && HAS_KEY ? describe : describe.skip;

function buildLiveConfig(): OpenClawConfig {
  if (!BASE_URL) {
    return {};
  }
  return {
    models: {
      providers: {
        google: {
          baseUrl: BASE_URL,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describeLive("google image-generation live", () => {
  it("generates a real image", async () => {
    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "google",
      model: MODEL,
      prompt:
        "Create a minimal flat illustration of an orange cat face sticker on a white background.",
      cfg: buildLiveConfig(),
      size: "1024x1024",
    });

    expect(result.model).toBeTruthy();
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0]?.mimeType.startsWith("image/")).toBe(true);
    expect(result.images[0]?.buffer.byteLength).toBeGreaterThan(512);
  }, 120_000);
});
