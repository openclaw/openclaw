import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins as loadPlugins,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { withEnv } from "../test-utils/env.js";
import { createVoiceProviderFixture } from "./provider-discovery.test-fixtures.js";
import { listRealtimeVoiceProviders } from "./provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider as resolveProvider } from "./provider-resolver.js";

function withVoiceProviders(
  run: (fixture: ReturnType<typeof voiceFixture>) => void,
  policy: OpenClawConfig["plugins"] = {},
) {
  const { cfg, env } = createVoiceProviderFixture(policy);
  return withEnv(env, () => run(voiceFixture(cfg)));
}

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const ready = (...ids: string[]): Record<string, { ready: true }> =>
  Object.fromEntries(ids.map((id) => [id, { ready: true }]));
const alias = "configured-voice-alias";
function voiceFixture(cfg: OpenClawConfig) {
  return {
    cfg,
    resolve: (options: Omit<Parameters<typeof resolveProvider>[0], "cfg"> = {}) =>
      resolveProvider({
        cfg,
        providerConfigs: ready("active-voice", "configured-voice"),
        ...options,
      }),
    loadActive: () =>
      loadPlugins({ config: cfg, onlyPluginIds: ["active-voice"] }).realtimeVoiceProviders.map(
        (entry) => entry.provider,
      ),
  };
}

it.each([false, true])("selects alias config with explicit selection=%s", (explicit) => {
  withVoiceProviders(({ cfg, resolve, loadActive }) => {
    const active = explicit ? undefined : loadActive();
    expect(active?.map((provider) => provider.id)).toEqual(explicit ? undefined : ["active-voice"]);
    const result = resolve({
      configuredProviderId: explicit ? alias : undefined,
      providerConfigs: explicit ? ready(alias) : ready("active-voice", alias),
    });
    expect(result).toMatchObject({ provider: { id: "configured-voice" } });
    expect(result.providerConfig).toEqual({ ready: true, resolved: true });
    // Per-call discovery must not broaden catalogs or replace active objects.
    if (active) {
      expect(listRealtimeVoiceProviders(cfg)).toEqual(active);
    }
  });
});

it.each([
  { label: "disabled", policy: { entries: { "configured-voice": { enabled: false } } } },
  { label: "denied", policy: { deny: ["configured-voice"] } },
  { label: "not allowed", policy: { allow: ["active-voice"] } },
])("does not auto-select a $label configured owner", ({ policy }) => {
  withVoiceProviders(({ resolve, loadActive }) => {
    loadActive();
    expect(resolve().provider.id).toBe("active-voice");
  }, policy);
});

it("does not discover configured owners when plugins are globally disabled", () => {
  withVoiceProviders(
    ({ resolve }) =>
      expect(() => resolve({ providerConfigs: ready("configured-voice") })).toThrow(
        "No realtime voice provider registered",
      ),
    { enabled: false },
  );
});

it("keeps a caller-supplied provider list authoritative", () => {
  withVoiceProviders(({ resolve, loadActive }) => {
    expect(resolve({ providers: loadActive() }).provider.id).toBe("active-voice");
  });
});
