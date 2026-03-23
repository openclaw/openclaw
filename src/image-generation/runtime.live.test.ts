import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { collectProviderApiKeys } from "../agents/live-auth-keys.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { getShellEnvAppliedKeys, loadShellEnvFallback } from "../infra/shell-env.js";
import { encodePngRgba, fillPixel } from "../media/png-encode.js";
import {
  imageGenerationProviderContractRegistry,
  providerContractRegistry,
} from "../plugins/contracts/registry.js";
import {
  DEFAULT_LIVE_IMAGE_MODELS,
  parseCaseFilter,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveImageModels,
  resolveLiveImageAuthStore,
} from "./live-test-helpers.js";
import { generateImage } from "./runtime.js";

const LIVE = isLiveTestEnabled();
const REQUIRE_PROFILE_KEYS = isTruthyEnvValue(process.env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
const describeLive = LIVE ? describe : describe.skip;

type LiveImageCase = {
  id: string;
  providerId: string;
  modelRef: string;
  prompt: string;
  size?: string;
  resolution?: "1K" | "2K" | "4K";
  inputImages?: Array<{ buffer: Buffer; mimeType: string; fileName?: string }>;
};

function createEditReferencePng(): Buffer {
  const width = 192;
  const height = 192;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 245, 248, 255, 255);
    }
  }

  for (let y = 24; y < 168; y += 1) {
    for (let x = 24; x < 168; x += 1) {
      fillPixel(buf, x, y, width, 255, 189, 89, 255);
    }
  }

  for (let y = 48; y < 144; y += 1) {
    for (let x = 48; x < 144; x += 1) {
      fillPixel(buf, x, y, width, 41, 47, 54, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function withPluginsEnabled(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      enabled: true,
    },
  };
}

function resolveProviderEnvVars(providerId: string): string[] {
  const entry = providerContractRegistry.find((candidate) => candidate.provider.id === providerId);
  return entry?.provider.envVars ?? [];
}

function maybeLoadShellEnvForImageProviders(providerIds: string[]): void {
  const expectedKeys = [
    ...new Set(providerIds.flatMap((providerId) => resolveProviderEnvVars(providerId))),
  ];
  if (expectedKeys.length === 0) {
    return;
  }
  loadShellEnvFallback({
    enabled: true,
    env: process.env,
    expectedKeys,
    logger: { warn: (message: string) => console.warn(message) },
  });
}

async function resolveLiveAuthForProvider(
  provider: string,
  cfg: ReturnType<typeof loadConfig>,
  agentDir: string,
) {
  const authStore = resolveLiveImageAuthStore({
    requireProfileKeys: REQUIRE_PROFILE_KEYS,
    hasLiveKeys: collectProviderApiKeys(provider).length > 0,
  });
  try {
    const auth = await resolveApiKeyForProvider({ provider, cfg, agentDir, store: authStore });
    return { auth, authStore };
  } catch {
    return null;
  }
}

describeLive("image generation live (provider sweep)", () => {
  it("generates images for every configured image-generation variant with available auth", async () => {
    const cfg = withPluginsEnabled(loadConfig());
    const agentDir = resolveOpenClawAgentDir();
    const providerFilter = parseCsvFilter(process.env.OPENCLAW_LIVE_IMAGE_GENERATION_PROVIDERS);
    const caseFilter = parseCaseFilter(process.env.OPENCLAW_LIVE_IMAGE_GENERATION_CASES);
    const envModelMap = parseProviderModelMap(process.env.OPENCLAW_LIVE_IMAGE_GENERATION_MODELS);
    const configuredModels = resolveConfiguredLiveImageModels(cfg);
    const availableProviders = imageGenerationProviderContractRegistry
      .map((entry) => entry.provider.id)
      .toSorted((left, right) => left.localeCompare(right))
      .filter((providerId) => (providerFilter ? providerFilter.has(providerId) : true));
    const liveCases: LiveImageCase[] = [];

    if (availableProviders.includes("google")) {
      liveCases.push(
        {
          id: "google:flash-generate",
          providerId: "google",
          modelRef:
            envModelMap.get("google") ??
            configuredModels.get("google") ??
            DEFAULT_LIVE_IMAGE_MODELS.google,
          prompt:
            "Create a minimal flat illustration of an orange cat face sticker on a white background.",
          size: "1024x1024",
        },
        {
          id: "google:pro-generate",
          providerId: "google",
          modelRef: "google/gemini-3-pro-image-preview",
          prompt:
            "Create a minimal flat illustration of an orange cat face sticker on a white background.",
          size: "1024x1024",
        },
        {
          id: "google:pro-edit",
          providerId: "google",
          modelRef: "google/gemini-3-pro-image-preview",
          prompt:
            "Change ONLY the background to a pale blue gradient. Keep the subject, framing, and style identical.",
          resolution: "2K",
          inputImages: [
            {
              buffer: createEditReferencePng(),
              mimeType: "image/png",
              fileName: "reference.png",
            },
          ],
        },
      );
    }
    if (availableProviders.includes("openai")) {
      liveCases.push({
        id: "openai:default-generate",
        providerId: "openai",
        modelRef:
          envModelMap.get("openai") ??
          configuredModels.get("openai") ??
          DEFAULT_LIVE_IMAGE_MODELS.openai,
        prompt:
          "Create a minimal flat illustration of an orange cat face sticker on a white background.",
        size: "1024x1024",
      });
    }

    const selectedCases = liveCases.filter((entry) =>
      caseFilter ? caseFilter.has(entry.id.toLowerCase()) : true,
    );

    maybeLoadShellEnvForImageProviders(availableProviders);

    const attempted: string[] = [];
    const skipped: string[] = [];
    const failures: string[] = [];

    for (const testCase of selectedCases) {
      if (!testCase.modelRef) {
        skipped.push(`${testCase.id}: no model configured`);
        continue;
      }
      const resolvedAuth = await resolveLiveAuthForProvider(testCase.providerId, cfg, agentDir);
      if (!resolvedAuth) {
        skipped.push(`${testCase.id}: no auth`);
        continue;
      }

      try {
        const result = await generateImage({
          cfg,
          agentDir,
          authStore: resolvedAuth.authStore,
          modelOverride: testCase.modelRef,
          prompt: testCase.prompt,
          size: testCase.size,
          resolution: testCase.resolution,
          inputImages: testCase.inputImages,
        });

        attempted.push(
          `${testCase.id}:${result.model} (${resolvedAuth.auth.source} ${redactLiveApiKey(resolvedAuth.auth.apiKey)})`,
        );
        expect(result.provider).toBe(testCase.providerId);
        expect(result.images.length).toBeGreaterThan(0);
        expect(result.images[0]?.mimeType.startsWith("image/")).toBe(true);
        expect(result.images[0]?.buffer.byteLength).toBeGreaterThan(512);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(
          `${testCase.id} (${resolvedAuth.auth.source} ${redactLiveApiKey(resolvedAuth.auth.apiKey)}): ${message}`,
        );
      }
    }

    console.log(
      `[live:image-generation] attempted=${attempted.join(", ") || "none"} skipped=${skipped.join(", ") || "none"} failures=${failures.join(" | ") || "none"} shellEnv=${getShellEnvAppliedKeys().join(", ") || "none"}`,
    );

    if (attempted.length === 0) {
      console.warn("[live:image-generation] no provider had usable auth; skipping assertions");
      return;
    }
    expect(failures).toEqual([]);
    expect(attempted.length).toBeGreaterThan(0);
  }, 180_000);
});
