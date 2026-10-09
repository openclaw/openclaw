// Covers shared media-generation runtime polling and timeout helpers.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  normalizeDurationToClosestMax,
  resolveCapabilityModelCandidates,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
  resolveMediaProviderRequestTimeoutMs,
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
  throwCapabilityGenerationFailure,
} from "./runtime-shared.js";

function parseModelRef(raw?: string) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

function configuredProvider(id: string, defaultModel: string) {
  return { id, defaultModel, isConfigured: () => true };
}

describe("media-generation runtime shared candidates", () => {
  it.each([
    [0, undefined, undefined],
    [1, { enabled: false }, "provider/model does not support reference-image edit inputs"],
    [
      2,
      { enabled: true, maxInputImages: 1 },
      "provider/model supports at most 1 reference image, 2 requested",
    ],
    [11, { enabled: true }, "provider/model supports at most 10 reference images, 11 requested"],
  ] as const)(
    "validates finite reference-image capability for %s inputs",
    (inputImageCount, edit, error) => {
      expect(
        resolveReferenceImageCapabilityError({
          candidateRef: "provider/model",
          inputImageCount,
          edit,
        }),
      ).toBe(error);
    },
  );

  it("appends auth-backed provider defaults after explicit refs by default", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } },
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
        fallbacks: ["fal/fal-ai/flux/dev"],
      },
      parseModelRef,
      listProviders: () => [
        configuredProvider("google", "gemini-3.1-flash-image-preview"),
        configuredProvider("openai", "gpt-image-1"),
        configuredProvider("minimax", "image-01"),
      ],
    });

    expect(candidates).toEqual([
      { provider: "google", model: "gemini-3.1-flash-image-preview" },
      { provider: "fal", model: "fal-ai/flux/dev" },
      { provider: "openai", model: "gpt-image-1" },
      { provider: "minimax", model: "image-01" },
    ]);
  });

  it.each([
    [
      "uses generic auth without custom readiness",
      undefined,
      [{ provider: "media-config-only", model: "configured-video" }],
    ],
    ["honors an owner readiness veto over generic auth", () => false, []],
  ] as const)("%s", (_name, isConfigured, expected) => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {
        models: {
          providers: {
            "media-config-only": {
              apiKey: "config-only-media-key",
              baseUrl: "https://media.example.test/v1",
              models: [],
            },
          },
        },
      },
      modelConfig: undefined,
      parseModelRef,
      listProviders: () => [
        {
          id: "media-config-only",
          defaultModel: "configured-video",
          isConfigured,
        },
      ],
    });

    expect(candidates).toEqual(expected);
  });

  it("orders auto-detected provider defaults by canonical aliases", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: { agents: { defaults: { model: { primary: "media-alias/gpt-5.5" } } } },
      modelConfig: undefined,
      parseModelRef,
      listProviders: () => [
        configuredProvider("fal", "fal-ai/flux/dev"),
        {
          ...configuredProvider("openai", "gpt-image-2"),
          aliases: ["media-alias"],
        },
      ],
    });

    expect(candidates).toEqual([
      { provider: "openai", model: "gpt-image-2" },
      { provider: "fal", model: "fal-ai/flux/dev" },
    ]);
  });

  it("keeps implicit provider expansion enabled when the retired opt-out is present", () => {
    let listProviderCalls = 0;
    const candidates = resolveCapabilityModelCandidates({
      cfg: {
        agents: { defaults: { mediaGenerationAutoProviderFallback: false } },
      } as OpenClawConfig,
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
      },
      parseModelRef,
      listProviders: () => {
        listProviderCalls += 1;
        return [configuredProvider("openai", "gpt-image-1")];
      },
    });

    expect(candidates).toEqual([
      { provider: "google", model: "gemini-3.1-flash-image-preview" },
      { provider: "openai", model: "gpt-image-1" },
    ]);
    expect(listProviderCalls).toBe(1);
  });

  it("treats an explicit model override as exact-only", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {},
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
        fallbacks: ["fal/fal-ai/flux/dev"],
      },
      modelOverride: "openai/gpt-image-2",
      parseModelRef,
      listProviders: () => [configuredProvider("google", "gemini-3.1-flash-image-preview")],
    });

    expect(candidates).toEqual([{ provider: "openai", model: "gpt-image-2" }]);
  });

  it("resolves slash-containing provider model IDs from registered provider models", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {},
      modelConfig: {
        primary: "openai/gpt-image-2",
      },
      modelOverride: "fal-ai/flux/dev",
      parseModelRef,
      listProviders: () => [
        {
          ...configuredProvider("fal", "fal-ai/flux/dev"),
          models: ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"],
        },
      ],
    });

    expect(candidates).toEqual([{ provider: "fal", model: "fal-ai/flux/dev" }]);
  });

  it("prefers explicit provider refs over colliding slash-containing model IDs", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {},
      modelConfig: {
        primary: "google/lyria-3-pro-preview",
      },
      parseModelRef,
      listProviders: () => [
        {
          ...configuredProvider("google", "lyria-3-clip-preview"),
          models: ["lyria-3-clip-preview", "lyria-3-pro-preview"],
        },
        {
          ...configuredProvider("openrouter", "google/lyria-3-clip-preview"),
          models: ["google/lyria-3-clip-preview", "google/lyria-3-pro-preview"],
        },
      ],
    });

    expect(candidates[0]).toEqual({ provider: "google", model: "lyria-3-pro-preview" });
  });
});

describe("media-generation candidate lifecycle", () => {
  it("preserves missing, skipped, and failed attempts before the first usable result", async () => {
    const calls: string[] = [];
    const result = await runMediaGenerationCandidates({
      request: {
        cfg: {
          agents: {
            defaults: {
              mediaModels: {
                image: {
                  primary: "missing/model",
                  fallbacks: ["skipped/model", "failed/model", "success/model", "unused/model"],
                },
              },
            },
          },
        },
        autoProviderFallback: false,
      },
      listProviders: () => [],
      capability: "image",
      getProvider(id) {
        calls.push(`lookup:${id}`);
        return id === "missing" ? undefined : { id };
      },
      prepareCandidate(candidate) {
        if (candidate.provider === "skipped") {
          return "reference inputs unsupported";
        }
        return async (attempts) => {
          calls.push(`generate:${candidate.provider}`);
          if (candidate.provider === "failed") {
            throw new Error("generation failed");
          }
          return { model: "selected-model", attempts };
        };
      },
    });

    expect(result.model).toBe("selected-model");
    expect(result.attempts).toStrictEqual([
      {
        provider: "missing",
        model: "model",
        error: "No image-generation provider registered for missing",
      },
      {
        provider: "skipped",
        model: "model",
        error: "reference inputs unsupported",
        reason: undefined,
        status: undefined,
        code: undefined,
      },
      {
        provider: "failed",
        model: "model",
        error: "generation failed",
        reason: undefined,
        status: undefined,
        code: undefined,
      },
    ]);
    expect(calls).toEqual([
      "lookup:missing",
      "lookup:skipped",
      "lookup:failed",
      "generate:failed",
      "lookup:success",
      "generate:success",
    ]);
  });

  it.each(["lookup", "prepare", "async prepare"])(
    "propagates %s failures without submitting a fallback",
    async (stage) => {
      const error = new Error("provider registry unavailable");
      const lookedUp: string[] = [];
      let executions = 0;
      const result = runMediaGenerationCandidates({
        request: {
          cfg: {
            agents: {
              defaults: {
                mediaModels: { video: { primary: "primary/model", fallbacks: ["fallback/model"] } },
              },
            },
          },
          autoProviderFallback: false,
        },
        listProviders: () => [],
        capability: "video",
        getProvider(id) {
          lookedUp.push(id);
          if (stage === "lookup") {
            throw error;
          }
          return { id };
        },
        prepareCandidate() {
          if (stage === "prepare") {
            throw error;
          }
          if (stage === "async prepare") {
            return Promise.reject(error);
          }
          return async () => {
            executions += 1;
            return "unexpected generation";
          };
        },
      });

      await expect(result).rejects.toBe(error);
      expect(lookedUp).toEqual(["primary"]);
      expect(executions).toBe(0);
    },
  );
});

describe("media-generation runtime shared normalization", () => {
  it("caps media provider timeouts to the timer-safe range", () => {
    expect(
      resolveMediaProviderRequestTimeoutMs({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        providerDefaultTimeoutMs: 30_000,
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveMediaProviderRequestTimeoutMs({
        timeoutMs: 0,
        providerDefaultTimeoutMs: 45_000,
      }),
    ).toBe(45_000);
  });

  it("rejects unsafe size dimensions before deriving ratios", () => {
    expect(
      resolveClosestSize({
        requestedSize: "9007199254740993x3",
        supportedSizes: ["1024x1024", "1536x1024"],
      }),
    ).toBeUndefined();
  });

  it("maps unsupported sizes to the closest supported size", () => {
    expect(
      resolveClosestSize({
        requestedSize: "1792x1024",
        supportedSizes: ["1024x1024", "1024x1536", "1536x1024"],
      }),
    ).toBe("1536x1024");
  });

  it("maps unsupported aspect ratios to the closest supported aspect ratio", () => {
    expect(
      resolveClosestAspectRatio({
        requestedAspectRatio: "17:10",
        supportedAspectRatios: ["1:1", "4:3", "16:9"],
      }),
    ).toBe("16:9");
  });

  it("maps video-style resolutions by numeric distance", () => {
    expect(
      resolveClosestResolution({
        requestedResolution: "480P",
        supportedResolutions: ["360P", "540P", "720P"],
      }),
    ).toBe("540P");
  });

  it("does not map across image and video resolution units", () => {
    expect(
      resolveClosestResolution({
        requestedResolution: "4K",
        supportedResolutions: ["768P", "1080P"],
      }),
    ).toBeUndefined();
  });

  it("keeps geometry tie-breaking independent of provider declaration order", () => {
    for (const reverse of [false, true]) {
      const ordered = <T>(values: T[]) => (reverse ? values.toReversed() : values);
      expect(
        resolveClosestAspectRatio({
          requestedAspectRatio: "3:3",
          supportedAspectRatios: ordered(["invalid", "2:2", "1:1"]),
        }),
      ).toBe("1:1");
      expect(
        resolveClosestSize({
          requestedAspectRatio: "1:1",
          supportedSizes: ordered(["invalid", "128x128", "64x64"]),
        }),
      ).toBe("64x64");
      expect(
        resolveClosestResolution({
          requestedResolution: "480P",
          supportedResolutions: ordered(["invalid", "360P", "600P"]),
        }),
      ).toBe("600P");
    }
  });

  it("clamps durations to the closest supported max", () => {
    expect(normalizeDurationToClosestMax(12, 8)).toBe(8);
    expect(normalizeDurationToClosestMax(6, 8)).toBe(6);
  });
});

describe("media-generation runtime shared failure summaries", () => {
  const abortedAttempts = ["minimax", "minimax-portal"].map((provider) => ({
    provider,
    model: "music-2.6",
    error: "This operation was aborted",
  }));

  it("collapses abort cascades behind the non-abort failure", () => {
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "music generation",
        attempts: [
          {
            provider: "google",
            model: "lyria-3-clip-preview",
            error: "Manually set deadline 1s is too short. Minimum allowed deadline is 10s.",
          },
          ...abortedAttempts,
        ],
        lastError: new Error("This operation was aborted"),
      }),
    ).toThrow(
      "All music generation models failed (3): google/lyria-3-clip-preview: Manually set deadline 1s is too short. Minimum allowed deadline is 10s. | 2 fallback(s) aborted after the request was cancelled or timed out: minimax/music-2.6, minimax-portal/music-2.6",
    );
  });

  it("summarizes all-aborted attempts once", () => {
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "music generation",
        attempts: abortedAttempts,
        lastError: new Error("This operation was aborted"),
      }),
    ).toThrow(
      "All music generation models failed (2): 2 fallback(s) aborted after the request was cancelled or timed out: minimax/music-2.6, minimax-portal/music-2.6",
    );
  });
});
