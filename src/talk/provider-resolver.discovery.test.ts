import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createVoiceProviderFixture } from "./provider-discovery.test-fixtures.js";
import { listRealtimeVoiceProviders } from "./provider-registry.js";
import { resolveConfiguredRealtimeVoiceProviderAsync } from "./provider-resolver.js";

function withVoiceProviders(
  run: (cfg: OpenClawConfig) => Promise<void>,
  policy: OpenClawConfig["plugins"] = {},
) {
  const { cfg, env } = createVoiceProviderFixture(policy);
  return withEnvAsync(env, () => run(cfg));
}

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("realtime voice provider discovery", () => {
  it.each(["configured-voice-alias"])(
    "discovers %s config ahead of a configured active provider",
    async (configKey) => {
      await withVoiceProviders(async (cfg) => {
        const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
        expect(registry.realtimeVoiceProviders.map((entry) => entry.provider.id)).toEqual([
          "active-voice",
        ]);

        const result = await resolveConfiguredRealtimeVoiceProviderAsync({
          cfg,
          providerConfigs: {
            "active-voice": { ready: true },
            [configKey]: { ready: true },
          },
        });

        expect(result.provider.id).toBe("configured-voice");
        expect(result.providerConfig).toEqual({ ready: true, resolved: true });
        // Per-call discovery must not broaden catalogs or replace active objects.
        expect(listRealtimeVoiceProviders(cfg)).toEqual(
          registry.realtimeVoiceProviders.map((entry) => entry.provider),
        );
      });
    },
  );

  it.each([
    { configKey: "configured-voice-alias", configuredProviderId: "configured-voice-alias" },
  ])(
    "selects cold $configKey config with explicit selection $configuredProviderId",
    async ({ configuredProviderId, configKey }) => {
      await withVoiceProviders(async (cfg) => {
        const result = await resolveConfiguredRealtimeVoiceProviderAsync({
          cfg,
          configuredProviderId,
          providerConfigs: { [configKey]: { ready: true } },
        });
        expect(result.provider.id).toBe("configured-voice");
      });
    },
  );

  it.each([
    { label: "disabled", policy: { entries: { "configured-voice": { enabled: false } } } },
    { label: "denied", policy: { deny: ["configured-voice"] } },
    { label: "not allowed", policy: { allow: ["active-voice"] } },
  ])("does not auto-select a $label configured owner", async ({ policy }) => {
    await withVoiceProviders(async (cfg) => {
      loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = await resolveConfiguredRealtimeVoiceProviderAsync({
        cfg,
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice": { ready: true },
        },
      });
      expect(result.provider.id).toBe("active-voice");
    }, policy);
  });

  it("does not discover configured owners when plugins are globally disabled", async () => {
    await withVoiceProviders(
      async (cfg) => {
        await expect(
          resolveConfiguredRealtimeVoiceProviderAsync({
            cfg,
            providerConfigs: { "configured-voice": { ready: true } },
          }),
        ).rejects.toThrow("No realtime voice provider registered");
      },
      { enabled: false },
    );
  });

  it("keeps a caller-supplied provider list authoritative", async () => {
    await withVoiceProviders(async (cfg) => {
      const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = await resolveConfiguredRealtimeVoiceProviderAsync({
        cfg,
        providers: registry.realtimeVoiceProviders.map((entry) => entry.provider),
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice": { ready: true },
        },
      });
      expect(result.provider.id).toBe("active-voice");
    });
  });
});
