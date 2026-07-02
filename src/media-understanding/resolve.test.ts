// Media-understanding resolve tests cover timeout clamping and capability filtering.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveMediaRuntimeTimeoutMs,
  resolveModelEntries,
  resolvePrompt,
  resolveTimeoutMs,
} from "./resolve.js";
import type { MediaUnderstandingCapability } from "./types.js";

const providerRegistry = new Map<string, { capabilities: MediaUnderstandingCapability[] }>([
  ["openai", { capabilities: ["image"] }],
  ["groq", { capabilities: ["audio"] }],
]);

describe("media timeout resolution", () => {
  it("caps configured media timeout seconds to timer-safe values", () => {
    expect(resolveTimeoutMs(Number.MAX_VALUE, 60)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveTimeoutMs(undefined, Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps explicit runtime timeout milliseconds to timer-safe values", () => {
    expect(resolveMediaRuntimeTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveMediaRuntimeTimeoutMs(undefined)).toBe(30_000);
  });
});

describe("resolveModelEntries", () => {
  it("uses provider capabilities for shared entries without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ provider: "openai", model: "gpt-5.4" }],
        },
      },
    };

    const imageEntries = resolveModelEntries({
      cfg,
      capability: "image",
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);

    const audioEntries = resolveModelEntries({
      cfg,
      capability: "audio",
      providerRegistry,
    });
    expect(audioEntries).toHaveLength(0);
  });

  it("keeps per-capability entries even without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          image: {
            models: [{ provider: "openai", model: "gpt-5.4" }],
          },
        },
      },
    };

    const imageEntries = resolveModelEntries({
      cfg,
      capability: "image",
      config: cfg.tools?.media?.image,
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);
  });

  it("skips shared CLI entries without capabilities", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ type: "cli", command: "gemini", args: ["--file", "{{MediaPath}}"] }],
        },
      },
    };

    const entries = resolveModelEntries({
      cfg,
      capability: "image",
      providerRegistry,
    });
    expect(entries).toHaveLength(0);
  });
});

describe("resolvePrompt", () => {
  it("uses the default audio prompt when no prompt and no language are configured", () => {
    expect(resolvePrompt("audio")).toBe("Transcribe the audio.");
  });

  it("uses an explicit audio prompt even when a non-English language is set", () => {
    expect(resolvePrompt("audio", "Transcribe in Russian.", undefined, "ru")).toBe(
      "Transcribe in Russian.",
    );
  });

  it("suppresses the default audio prompt for a non-English language hint", () => {
    // Groq Whisper treats `prompt` as a biasing hint; the English default
    // can make it translate short non-English clips to English (#98970).
    expect(resolvePrompt("audio", undefined, undefined, "ru")).toBe("");
  });

  it("keeps the default audio prompt for an English language hint", () => {
    expect(resolvePrompt("audio", undefined, undefined, "en")).toBe("Transcribe the audio.");
  });

  it("keeps the default audio prompt for an English region tag (en-US)", () => {
    expect(resolvePrompt("audio", undefined, undefined, "en-US")).toBe("Transcribe the audio.");
  });

  it("suppresses the default audio prompt for a region-qualified non-English hint (zh-CN)", () => {
    expect(resolvePrompt("audio", undefined, undefined, "zh-CN")).toBe("");
  });

  it("appends length guidance for non-audio capabilities", () => {
    expect(resolvePrompt("image", undefined, 500)).toBe(
      "Describe the image. Respond in at most 500 characters.",
    );
  });
});
