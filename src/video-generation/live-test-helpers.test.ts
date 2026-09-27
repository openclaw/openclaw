import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  canRunBufferBackedImageToVideoLiveLane,
  canRunBufferBackedVideoToVideoLiveLane,
  parseVideoProviderFilter,
  parseProviderModelMap,
  resolveConfiguredLiveVideoModels,
  resolveLiveVideoResolution,
} from "./live-test-helpers.js";

describe("video-generation live-test helpers", () => {
  it.each([
    ["alibaba", "alibaba/wan2.6-t2v", "720P"],
    ["qwen", "qwen/wan2.6-t2v", "720P"],
    ["minimax", "minimax/MiniMax-Hailuo-2.3", "768P"],
    ["pixverse", "pixverse/v6", "540P"],
    ["google", "google/veo-3.1-fast-generate-preview", "480P"],
  ] as const)("uses a supported %s live resolution", (providerId, modelRef, expected) => {
    expect(resolveLiveVideoResolution({ providerId, modelRef })).toBe(expected);
  });

  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseVideoProviderFilter()).toBeNull();
    expect(parseVideoProviderFilter("all")).toBeNull();
    expect(parseVideoProviderFilter(" google , openai ")).toEqual(new Set(["google", "openai"]));
  });

  it("parses provider model overrides by provider id", () => {
    expect(
      parseProviderModelMap("google/veo-3.1-fast-generate-preview, openai/sora-2, invalid"),
    ).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
      ]),
    );
  });

  it("collects configured models from primary and fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          mediaModels: {
            video: {
              primary: "google/veo-3.1-fast-generate-preview",
              fallbacks: ["openai/sora-2", "invalid"],
            },
          },
        },
      },
    };

    expect(resolveConfiguredLiveVideoModels(cfg)).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
      ]),
    );
  });

  it("runs buffer-backed video-to-video only for supported providers/models", () => {
    for (const [providerId, modelRef, expected] of [
      ["google", "google/veo-3.1-fast-generate-preview", false],
      ["openai", "openai/sora-2", false],
      ["runway", "runway/gen4_aleph", true],
      ["runway", "runway/gen4.5", false],
      ["alibaba", "alibaba/wan2.6-r2v", false],
      ["qwen", "qwen/wan2.6-r2v", false],
      ["xai", "xai/grok-imagine-video", false],
    ] as const) {
      expect(canRunBufferBackedVideoToVideoLiveLane({ providerId, modelRef }), modelRef).toBe(
        expected,
      );
    }
  });

  it("runs buffer-backed image-to-video only for providers that accept bundled image inputs", () => {
    for (const [providerId, modelRef, expected] of [
      ["openai", "openai/sora-2", true],
      ["vydra", "vydra/veo3", false],
      ["together", "together/Wan-AI/Wan2.2-T2V-A14B", false],
      ["together", "together/Wan-AI/Wan2.2-I2V-A14B", true],
    ] as const) {
      expect(canRunBufferBackedImageToVideoLiveLane({ providerId, modelRef }), modelRef).toBe(
        expected,
      );
    }
  });
});
