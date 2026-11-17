import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { parseGenerationModelRef } from "../../packages/media-generation-core/src/model-ref.js";
import { buildDashscopeVideoGenerationProvider } from "../plugin-sdk/video-generation.js";
import {
  resolveCapabilityModelCandidates,
  resolveCapabilityModelCandidatesAsync,
  resolveMediaProviderRequestTimeoutMs as requestTimeout,
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
  throwCapabilityGenerationFailure,
} from "./runtime-shared.js";

function configuredProvider(id: string, defaultModel = `${id}-image`) {
  return { id, defaultModel, isConfiguredAsync: async () => true };
}
function ref(provider: string, model = `${provider}-image`) {
  return { provider, model };
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

const imageModels = { primary: "google/google-image", fallbacks: ["fal/fal-ai/flux/dev"] };
const google = configuredProvider("google");
const fal = configuredProvider("fal", "fal-ai/flux/dev");
const openai = configuredProvider("openai");

it.each([
  ["standard-key", "https://dashscope.example.test", true],
  ["subscription-key", "https://dashscope.example.test", false],
  ["standard-key", "https://coding.example.test", false],
] as const)("enforces DashScope policy (%s, %s)", async (apiKey, baseUrl, allowed) => {
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
});

it.each([
  [0, undefined, undefined],
  [1, { enabled: false }, "p/m does not support reference-image edit inputs"],
  [2, { enabled: true, maxInputImages: 1 }, "p/m supports at most 1 reference image, 2 requested"],
  [11, { enabled: true }, "p/m supports at most 10 reference images, 11 requested"],
] as const)("validates %s reference-image inputs", (inputImageCount, edit, error) => {
  const params = { candidateRef: "p/m", inputImageCount, edit };
  expect(resolveReferenceImageCapabilityError(params)).toBe(error);
});

type ProviderOrderCase = {
  name: string;
  providers: Parameters<typeof resolveCandidates>[0];
  primary: string;
  modelConfig: CandidateParams["modelConfig"];
  expected: ReturnType<typeof ref>[];
};
it.each`
  name          | providers                                          | primary               | modelConfig    | expected
  ${"explicit"} | ${[google, openai, configuredProvider("minimax")]} | ${"openai/text"}      | ${imageModels} | ${[ref("google"), ref("fal", "fal-ai/flux/dev"), ref("openai"), ref("minimax")]}
  ${"alias"}    | ${[fal, { ...openai, aliases: ["media-alias"] }]}  | ${"media-alias/text"} | ${undefined}   | ${[ref("openai"), ref("fal", "fal-ai/flux/dev")]}
`(
  "orders provider defaults after $name",
  async ({ providers, expected, primary, modelConfig }: ProviderOrderCase) => {
    const options = { cfg: { agents: { defaults: { model: { primary } } } }, modelConfig };
    await expect(resolveCandidates(providers, options)).resolves.toEqual(expected);
  },
);

it("treats an explicit model override as exact-only", async () => {
  const options = { modelConfig: imageModels, modelOverride: "openai/openai-image" };
  await expect(resolveCandidates([google], options)).resolves.toEqual([ref("openai")]);
});

it.each([
  ["uses generic auth without custom readiness", undefined, true],
  ["honors an owner readiness veto over generic auth", () => false, false],
] as const)("%s", async (_name, isConfigured, allowed) => {
  const candidates = await resolveCandidates(
    [{ id: "media", defaultModel: "video", isConfigured }],
    { cfg: providerConfig("media", "test-key", "https://media.example.test/v1") },
  );

  expect(candidates).toEqual(allowed ? [ref("media", "video")] : []);
});

it("uses async readiness and observes an in-process credential change", async () => {
  let configured = false;
  const provider = {
    ...configuredProvider("media", "image"),
    isConfigured: () => {
      throw new Error("deprecated readiness must not run");
    },
    isConfiguredAsync: async () => configured,
  };
  const resolve = () => resolveCandidates([provider]);
  expect(await resolve()).toEqual([]);
  configured = true;
  expect(await resolve()).toEqual([ref("media", "image")]);
});

it("preserves missing, skipped, and failed attempts before the first usable result", async () => {
  const result = await runMediaGenerationCandidates({
    request: candidateRequest("image", ["missing", "skipped", "failed", "success", "unused"]),
    listProviders: () => [],
    capability: "image",
    getProvider(id) {
      if (id === "unused") {
        throw new Error("must stop after success");
      }
      return id === "missing" ? undefined : { id };
    },
    prepareCandidate(candidate) {
      if (candidate.provider === "skipped") {
        return "reference inputs unsupported";
      }
      return async (attempts) => {
        if (candidate.provider === "failed") {
          throw new Error("generation failed");
        }
        return { model: "selected-model", attempts };
      };
    },
  });

  const failure = (provider: string, error: string) => ({ ...ref(provider, "model"), error });
  expect(result).toEqual({
    model: "selected-model",
    attempts: [
      failure("missing", "No image-generation provider registered for missing"),
      failure("skipped", "reference inputs unsupported"),
      failure("failed", "generation failed"),
    ],
  });
});

it("propagates async prepare failures without submitting a fallback", async () => {
  const error = new Error("provider registry unavailable");
  const result = runMediaGenerationCandidates({
    request: candidateRequest("video", ["primary", "fallback"]),
    listProviders: () => [],
    capability: "video",
    getProvider(id) {
      expect(id).toBe("primary");
      return { id };
    },
    prepareCandidate() {
      return Promise.reject(error);
    },
  });

  await expect(result).rejects.toBe(error);
});

it.each([
  [Number.MAX_SAFE_INTEGER, 30_000, MAX_TIMER_TIMEOUT_MS],
  [0, 45_000, 45_000],
])("resolves timeout %s", (timeoutMs, providerDefaultTimeoutMs, expected) => {
  expect(requestTimeout({ timeoutMs, providerDefaultTimeoutMs })).toBe(expected);
});

it("collapses abort cascades behind the non-abort failure", () => {
  const error = "This operation was aborted";
  const abortedAttempts = ["minimax", "minimax-portal"].map((provider) => ({
    provider,
    model: "music-2.6",
    error,
  }));
  const params = {
    capabilityLabel: "music generation",
    attempts: [
      { provider: "google", model: "clip", error: "deadline too short" },
      ...abortedAttempts,
    ],
    lastError: new Error(error),
  };
  expect(() => throwCapabilityGenerationFailure(params)).toThrow(
    "All music generation models failed (3): google/clip: deadline too short | 2 fallback(s) aborted after the request was cancelled or timed out: minimax/music-2.6, minimax-portal/music-2.6",
  );
});
