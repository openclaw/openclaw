import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAmbientOnlyConfiguredChannelIds,
  listGatewayActivatedChannelIds as activatedChannelIds,
} from "../plugins/channel-presence-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveGatewayReloadPluginActivationCandidate } from "./plugin-activation-runtime-config.js";
import { loadGatewayStartupConfigSnapshot } from "./server-startup-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "discord", channels: ["discord"] }],
});

beforeEach(() => {
  const root = tempDirs.make("openclaw-ambient-channels-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv("DISCORD_BOT_TOKEN", "fake-token-for-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearPluginMetadataLifecycleCaches();
});

it.each<[string, AmbientEnvTriggerPolicy, OpenClawConfig["channels"], boolean]>([
  ["default env-only suppression", "suppress", {}, false],
  ["ambient opt-in", "allow", {}, true],
  ["explicit channel config", "suppress", { discord: { dmPolicy: "pairing" } }, true],
  ["explicit disable with opt-in", "allow", { discord: { enabled: false } }, false],
])(
  "preserves %s through initial config loading and reload",
  async (_name, ambientEnvTriggers, channels, enabled) => {
    const sourceConfig: OpenClawConfig = { channels };
    const snapshot = createSnapshot({
      path: process.env.OPENCLAW_CONFIG_PATH!,
      sourceConfig,
      hash: "ambient-channels",
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    const startup = await loadGatewayStartupConfigSnapshot({
      minimalTestGateway: false,
      ambientEnvTriggers,
      log,
      initialSnapshotRead: { snapshot, pluginMetadataSnapshot: metadata },
    });
    const reload = resolveGatewayReloadPluginActivationCandidate({
      sourceConfig: { ...sourceConfig, logging: { level: "debug" } },
      env: process.env,
      manifestRegistry: metadata.manifestRegistry,
      ambientEnvTriggers,
    });

    for (const config of [startup.snapshot.config, reload]) {
      expect(config.channels?.discord?.enabled === true).toBe(enabled);
      expect(
        activatedChannelIds({
          config,
          activationSourceConfig: sourceConfig,
          env: process.env,
          manifestRecords: metadata.plugins,
          ambientEnvTriggers,
        }),
      ).toEqual(enabled ? ["discord"] : []);
    }
    expect(startup.snapshot.sourceConfig).toBe(sourceConfig);
    expect(sourceConfig.channels).toEqual(channels);
    if (Object.keys(channels ?? {}).length === 0) {
      expect(sourceConfig.channels?.discord).toBeUndefined();
      expect(log.info).toHaveBeenCalledTimes(enabled ? 1 : 0);
    }
  },
);

it("does not treat generated channel enablement as authored consent", () => {
  const params = {
    config: { channels: { discord: { enabled: true } } },
    activationSourceConfig: { channels: {} },
    env: process.env,
    manifestRecords: metadata.plugins,
    includePersistedAuthState: false,
  };
  expect(listAmbientOnlyConfiguredChannelIds(params)).toEqual(["discord"]);
  expect(activatedChannelIds({ ...params, ambientEnvTriggers: "suppress" })).toEqual([]);
});
