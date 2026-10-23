import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";
import { buildDashscopeVideoGenerationProvider } from "../plugin-sdk/video-generation.js";
import {
  normalizeDurationToClosestMax,
  resolveCapabilityModelCandidates,
  resolveCapabilityModelCandidatesAsync,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
  resolveMediaProviderRequestTimeoutMs,
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
  throwCapabilityGenerationFailure,
} from "./runtime-shared.js";

function configuredProvider(id: string, defaultModel: string) {
  return { id, defaultModel, isConfiguredAsync: async () => true };
}

type CandidateParams = Parameters<typeof resolveCapabilityModelCandidatesAsync>[0];
function candidateParams(overrides: Partial<Omit<CandidateParams, "parseModelRef">>) {
  return { cfg: {}, modelConfig: undefined, parseModelRef: parseGenerationModelRef, ...overrides };
}

function resolveCandidates(
  providers: ReturnType<NonNullable<CandidateParams["listProviders"]>>,
  overrides: Parameters<typeof candidateParams>[0] = {},
) {
  return resolveCapabilityModelCandidatesAsync(
    candidateParams({ listProviders: () => providers, ...overrides }),
  );
}

function providerConfig(id: string, apiKey: string, baseUrl: string, auth?: "api-key") {
  return {
    models: { providers: { [id]: { apiKey, baseUrl, models: [], ...(auth && { auth }) } } },
  };
}

function candidateRequest(capability: "image" | "video", providers: string[]) {
  const [primary, ...fallbacks] = providers.map((provider) => `${provider}/model`);
  const mediaModels = { [capability]: { primary, fallbacks } };
  return { cfg: { agents: { defaults: { mediaModels } } }, autoProviderFallback: false };
}

const imageModels = {
  primary: "google/gemini-3.1-flash-image-preview",
  fallbacks: ["fal/fal-ai/flux/dev"],
};
const google = configuredProvider("google", "gemini-3.1-flash-image-preview");
const fal = configuredProvider("fal", "fal-ai/flux/dev");
const openai = configuredProvider("openai", "gpt-image-2");

it.each([
  ["standard-key", "https://dashscope.example.test", true],
  ["subscription-key", "https://dashscope.example.test", false],
  ["standard-key", "https://coding.example.test", false],
] as const)(
  "preserves DashScope factory policy in sync and async discovery (%s, %s)",
  async (apiKey, baseUrl, allowed) => {
    const provider = buildDashscopeVideoGenerationProvider({
      providerId: "qwen",
      label: "Qwen",
      taskLabel: "Qwen",
      defaultBaseUrl: "https://dashscope.example.test",
      credentialPolicy: {
        acceptsApiKey: (key) => key === "standard-key",
        acceptsBaseUrl: (url) => url !== "https://coding.example.test",
        unsupportedMessage: "Use Standard credentials and endpoint",
      },
    });
    const params = candidateParams({
      cfg: providerConfig("qwen", apiKey, baseUrl, "api-key"),
      listProviders: () => [provider],
    });
    const expected = allowed ? [{ provider: "qwen", model: provider.defaultModel }] : [];
    expect(resolveCapabilityModelCandidates(params)).toEqual(expected);
    expect(await resolveCapabilityModelCandidatesAsync(params)).toEqual(expected);
  },
);

it.each([
  [0, undefined, undefined],
  [1, { enabled: false }, "p/m does not support reference-image edit inputs"],
  [2, { enabled: true, maxInputImages: 1 }, "p/m supports at most 1 reference image, 2 requested"],
  [11, { enabled: true }, "p/m supports at most 10 reference images, 11 requested"],
] as const)("validates %s reference-image inputs", (inputImageCount, edit, error) => {
  const result = resolveReferenceImageCapabilityError({
    candidateRef: "p/m",
    inputImageCount,
    edit,
  });
  expect(result).toBe(error);
});

it.each([
  {
    name: "appends auth-backed provider defaults after explicit refs by default",
    providers: [
      google,
      configuredProvider("openai", "gpt-image-1"),
      configuredProvider("minimax", "image-01"),
    ],
    options: {
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } },
      modelConfig: imageModels,
    },
    expected: [
      { provider: "google", model: "gemini-3.1-flash-image-preview" },
      { provider: "fal", model: "fal-ai/flux/dev" },
      { provider: "openai", model: "gpt-image-1" },
      { provider: "minimax", model: "image-01" },
    ],
  },
  {
    name: "orders auto-detected provider defaults by canonical aliases",
    providers: [fal, { ...openai, aliases: ["media-alias"] }],
    options: { cfg: { agents: { defaults: { model: { primary: "media-alias/gpt-5.5" } } } } },
    expected: [
      { provider: "openai", model: "gpt-image-2" },
      { provider: "fal", model: "fal-ai/flux/dev" },
    ],
  },
  {
    name: "treats an explicit model override as exact-only",
    providers: [google],
    options: { modelConfig: imageModels, modelOverride: "openai/gpt-image-2" },
    expected: [{ provider: "openai", model: "gpt-image-2" }],
  },
])("$name", async ({ providers, options, expected }) => {
  expect(await resolveCandidates(providers, options)).toEqual(expected);
});

it.each([
  [
    "uses generic auth without custom readiness",
    undefined,
    [{ provider: "media-config-only", model: "configured-video" }],
  ],
  ["honors an owner readiness veto over generic auth", () => false, []],
] as const)("%s", async (_name, isConfigured, expected) => {
  const candidates = await resolveCandidates(
    [{ id: "media-config-only", defaultModel: "configured-video", isConfigured }],
    {
      cfg: providerConfig(
        "media-config-only",
        "config-only-media-key",
        "https://media.example.test/v1",
      ),
    },
  );

  expect(candidates).toEqual(expected);
});

it("uses async readiness and observes an in-process credential change", async () => {
  let configured = false;
  const resolve = () =>
    resolveCandidates([
      {
        id: "media",
        defaultModel: "image",
        isConfigured: () => {
          throw new Error("deprecated readiness must not run");
        },
        isConfiguredAsync: async () => configured,
      },
    ]);

  expect(await resolve()).toEqual([]);
  configured = true;
  expect(await resolve()).toEqual([{ provider: "media", model: "image" }]);
});

it("preserves missing, skipped, and failed attempts before the first usable result", async () => {
  const calls: string[] = [];
  const result = await runMediaGenerationCandidates({
    request: candidateRequest("image", ["missing", "skipped", "failed", "success", "unused"]),
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
  const failedAttempt = (provider: string, error: string) => ({
    provider,
    model: "model",
    error,
    reason: undefined,
    status: undefined,
    code: undefined,
  });
  expect(result.attempts).toStrictEqual([
    {
      provider: "missing",
      model: "model",
      error: "No image-generation provider registered for missing",
    },
    failedAttempt("skipped", "reference inputs unsupported"),
    failedAttempt("failed", "generation failed"),
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

it("propagates async prepare failures without submitting a fallback", async () => {
  const error = new Error("provider registry unavailable");
  const lookedUp: string[] = [];
  const result = runMediaGenerationCandidates({
    request: candidateRequest("video", ["primary", "fallback"]),
    listProviders: () => [],
    capability: "video",
    getProvider(id) {
      lookedUp.push(id);
      return { id };
    },
    prepareCandidate() {
      return Promise.reject(error);
    },
  });

  await expect(result).rejects.toBe(error);
  expect(lookedUp).toEqual(["primary"]);
});

it.each([
  [Number.MAX_SAFE_INTEGER, 30_000, MAX_TIMER_TIMEOUT_MS],
  [0, 45_000, 45_000],
])(
  "resolves timeout %s with provider default %s",
  (timeoutMs, providerDefaultTimeoutMs, expected) => {
    expect(resolveMediaProviderRequestTimeoutMs({ timeoutMs, providerDefaultTimeoutMs })).toBe(
      expected,
    );
  },
);

it.each([
  ["9007199254740993x3", ["1024x1024", "1536x1024"], undefined],
  ["1792x1024", ["1024x1024", "1024x1536", "1536x1024"], "1536x1024"],
] as const)("normalizes size %s", (requestedSize, supportedSizes, expected) => {
  expect(resolveClosestSize({ requestedSize, supportedSizes })).toBe(expected);
});

it("does not map across image and video resolution units", () => {
  const resolution = resolveClosestResolution({
    requestedResolution: "4K",
    supportedResolutions: ["768P", "1080P"],
  });
  expect(resolution).toBeUndefined();
});

it("keeps geometry tie-breaking independent of provider declaration order", () => {
  for (const reverse of [false, true]) {
    const ordered = <T>(values: T[]) => (reverse ? values.toReversed() : values);
    const aspectRatio = resolveClosestAspectRatio({
      requestedAspectRatio: "3:3",
      supportedAspectRatios: ordered(["invalid", "2:2", "1:1"]),
    });
    expect(aspectRatio).toBe("1:1");
    const size = resolveClosestSize({
      requestedAspectRatio: "1:1",
      supportedSizes: ordered(["invalid", "128x128", "64x64"]),
    });
    expect(size).toBe("64x64");
    const resolution = resolveClosestResolution({
      requestedResolution: "480P",
      supportedResolutions: ordered(["invalid", "360P", "600P"]),
    });
    expect(resolution).toBe("600P");
  }
});

it("clamps durations to the closest supported max", () => {
  expect(normalizeDurationToClosestMax(12, 8)).toBe(8);
  expect(normalizeDurationToClosestMax(6, 8)).toBe(6);
});

it("collapses abort cascades behind the non-abort failure", () => {
  const abortedAttempts = ["minimax", "minimax-portal"].map((provider) => ({
    provider,
    model: "music-2.6",
    error: "This operation was aborted",
  }));

  expect(() =>
    throwCapabilityGenerationFailure({
      capabilityLabel: "music generation",
      attempts: [
        { provider: "google", model: "clip", error: "deadline too short" },
        ...abortedAttempts,
      ],
      lastError: new Error("This operation was aborted"),
    }),
  ).toThrow(
    "All music generation models failed (3): google/clip: deadline too short | 2 fallback(s) aborted after the request was cancelled or timed out: minimax/music-2.6, minimax-portal/music-2.6",
  );
});
