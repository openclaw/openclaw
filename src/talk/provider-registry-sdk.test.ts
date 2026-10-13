import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeRealtimeVoiceProviderId,
  canonicalizeRealtimeVoiceProviderIdAsync,
  getRealtimeVoiceProvider,
  getRealtimeVoiceProviderAsync,
  listRealtimeVoiceProviders,
  listRealtimeVoiceProvidersAsync,
  resolveConfiguredRealtimeVoiceProvider,
  resolveConfiguredRealtimeVoiceProviderAsync,
} from "../plugin-sdk/realtime-voice.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createVoiceProviderFixture } from "./provider-discovery.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("realtime voice SDK discovery", () => {
  it.each(["legacy", "async"] as const)(
    "resolves a cold provider alias through the %s public API",
    async (mode) => {
      const { cfg, env } = createVoiceProviderFixture();
      await withEnvAsync(env, async () => {
        const providerId = "configured-voice-alias";
        const provider = await (mode === "legacy"
          ? getRealtimeVoiceProvider(providerId, cfg)
          : getRealtimeVoiceProviderAsync(providerId, cfg));
        expect(provider?.id).toBe("configured-voice");
        expect(
          await (mode === "legacy"
            ? canonicalizeRealtimeVoiceProviderId(providerId, cfg)
            : canonicalizeRealtimeVoiceProviderIdAsync(providerId, cfg)),
        ).toBe("configured-voice");
        expect(
          (
            await (mode === "legacy"
              ? listRealtimeVoiceProviders(cfg)
              : listRealtimeVoiceProvidersAsync(cfg))
          ).map((entry) => entry.id),
        ).toEqual(["active-voice", "configured-voice"]);
        const params = {
          cfg,
          configuredProviderId: providerId,
          providerConfigs: { [providerId]: { ready: true } },
        };
        const resolved = await (mode === "legacy"
          ? resolveConfiguredRealtimeVoiceProvider(params)
          : resolveConfiguredRealtimeVoiceProviderAsync(params));
        expect(resolved.provider.id).toBe("configured-voice");
        expect(resolved.providerConfig).toEqual({ ready: true, resolved: true });
      });
    },
  );
});
