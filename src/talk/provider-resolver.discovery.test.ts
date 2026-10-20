import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { withEnv } from "../test-utils/env.js";
import { createVoiceProviderFixture } from "./provider-discovery.test-fixtures.js";
import { listRealtimeVoiceProviders } from "./provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "./provider-resolver.js";

function withVoiceProviders(
  run: (cfg: OpenClawConfig) => void,
  policy: OpenClawConfig["plugins"] = {},
) {
  const { cfg, env } = createVoiceProviderFixture(policy);
  return withEnv(env, () => run(cfg));
}

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const bothProviders = {
  "active-voice": { ready: true },
  "configured-voice": { ready: true },
};
function loadActive(cfg: OpenClawConfig) {
  return loadOpenClawPlugins({
    config: cfg,
    onlyPluginIds: ["active-voice"],
  }).realtimeVoiceProviders.map((entry) => entry.provider);
}

describe("realtime voice provider discovery", () => {
  it("discovers alias config ahead of a configured active provider", () => {
    withVoiceProviders((cfg) => {
      const active = loadActive(cfg);
      expect(active.map((provider) => provider.id)).toEqual(["active-voice"]);
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice-alias": { ready: true },
        },
      });
      expect(result.provider.id).toBe("configured-voice");
      expect(result.providerConfig).toEqual({ ready: true, resolved: true });
      // Per-call discovery must not broaden catalogs or replace active objects.
      expect(listRealtimeVoiceProviders(cfg)).toEqual(active);
    });
  });

  it("selects cold alias config with explicit alias selection", () => {
    withVoiceProviders((cfg) => {
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        configuredProviderId: "configured-voice-alias",
        providerConfigs: { "configured-voice-alias": { ready: true } },
      });
      expect(result.provider.id).toBe("configured-voice");
    });
  });

  it.each([
    { label: "disabled", policy: { entries: { "configured-voice": { enabled: false } } } },
    { label: "denied", policy: { deny: ["configured-voice"] } },
    { label: "not allowed", policy: { allow: ["active-voice"] } },
  ])("does not auto-select a $label configured owner", ({ policy }) => {
    withVoiceProviders((cfg) => {
      loadActive(cfg);
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providerConfigs: bothProviders,
      });
      expect(result.provider.id).toBe("active-voice");
    }, policy);
  });

  it("does not discover configured owners when plugins are globally disabled", () => {
    withVoiceProviders(
      (cfg) => {
        expect(() =>
          resolveConfiguredRealtimeVoiceProvider({
            cfg,
            providerConfigs: { "configured-voice": { ready: true } },
          }),
        ).toThrow("No realtime voice provider registered");
      },
      { enabled: false },
    );
  });

  it("keeps a caller-supplied provider list authoritative", () => {
    withVoiceProviders((cfg) => {
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providers: loadActive(cfg),
        providerConfigs: bothProviders,
      });
      expect(result.provider.id).toBe("active-voice");
    });
  });
});
