import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { resolveMediaRuntimeTimeoutMs, resolveModelEntries, resolveTimeoutMs } from "./resolve.js";
import type { MediaUnderstandingCapability } from "./types.js";

const providerRegistry = new Map<string, { capabilities: MediaUnderstandingCapability[] }>([
  ["openai", { capabilities: ["image"] }],
  ["groq", { capabilities: ["audio"] }],
]);

function resolve(
  models: MediaUnderstandingModelConfig[],
  capability: MediaUnderstandingCapability,
  preferredModel?: string,
) {
  const cfg: OpenClawConfig = { tools: { media: { models } } };
  return resolveModelEntries({ cfg, capability, config: { preferredModel }, providerRegistry });
}

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
    const models = [{ provider: "openai", model: "gpt-5.4" }];
    const imageEntries = resolve(models, "image");
    expect(imageEntries).toMatchObject([
      {
        entry: { provider: "openai", model: "gpt-5.4" },
        secretOwnerId: "media-model:shared:0",
      },
    ]);

    expect(resolve(models, "audio")).toHaveLength(0);
  });

  it("orders capability-tagged shared entries by the per-capability preference", () => {
    const imageEntries = resolve(
      [
        { type: "cli", command: "unused-media-fixture" },
        { provider: "openai", model: "gpt-5.4-mini", capabilities: ["image"] },
        { provider: "openai", model: "gpt-5.4", capabilities: ["image"] },
      ],
      "image",
      "openai/gpt-5.4",
    );
    expect(imageEntries).toMatchObject([
      { entry: { model: "gpt-5.4" }, secretOwnerId: "media-model:shared:2" },
      { entry: { model: "gpt-5.4-mini" }, secretOwnerId: "media-model:shared:1" },
    ]);
  });

  it("ranks an exact provider-qualified preference above a matching bare model id", () => {
    const entries = resolve(
      [
        { provider: "openrouter", model: "openai/gpt-5.4", capabilities: ["image"] },
        { provider: "openai", model: "gpt-5.4", capabilities: ["image"] },
      ],
      "image",
      "openai/gpt-5.4",
    );
    expect(entries[0]?.entry).toMatchObject({ provider: "openai", model: "gpt-5.4" });
  });

  it("prefers a provider-default entry without requiring a model id", () => {
    const entries = resolve(
      [
        { provider: "groq", model: "whisper-large-v3", capabilities: ["audio"] },
        { provider: "openai", capabilities: ["audio"] },
      ],
      "audio",
      "provider:openai",
    );
    expect(entries[0]?.entry.provider).toBe("openai");
  });
});
