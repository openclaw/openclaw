import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAmbientOnlyConfiguredChannelIds,
  listGatewayActivatedChannelIds,
} from "../plugins/channel-presence-policy.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveGatewayReloadPluginActivationCandidate } from "./plugin-activation-runtime-config.js";
import { loadGatewayStartupConfigSnapshot } from "./server-startup-config-helpers.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

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

describe("Gateway channel activation consent", () => {
  it.each<{
    name: string;
    ambientEnvTriggers: AmbientEnvTriggerPolicy;
    channels: OpenClawConfig["channels"];
    enabled: boolean;
  }>([
    {
      name: "default env-only suppression",
      ambientEnvTriggers: "suppress",
      channels: {},
      enabled: false,
    },
    { name: "ambient opt-in", ambientEnvTriggers: "allow", channels: {}, enabled: true },
    {
      name: "explicit channel config",
      ambientEnvTriggers: "suppress",
      channels: { discord: { dmPolicy: "pairing" } },
      enabled: true,
    },
    {
      name: "explicit disable with opt-in",
      ambientEnvTriggers: "allow",
      channels: { discord: { enabled: false } },
      enabled: false,
    },
  ])(
    "preserves $name through initial config loading and reload",
    async ({ ambientEnvTriggers, channels, enabled }) => {
      const sourceConfig: OpenClawConfig = { channels };
      const snapshot = buildTestConfigSnapshot({
        path: process.env.OPENCLAW_CONFIG_PATH!,
        exists: true,
        raw: JSON.stringify(sourceConfig),
        parsed: sourceConfig,
        valid: true,
        config: sourceConfig,
        issues: [],
        legacyIssues: [],
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      const startupParams = {
        minimalTestGateway: false,
        ambientEnvTriggers,
        log,
        initialSnapshotRead: { snapshot, pluginMetadataSnapshot: metadata },
      };
      const startup = await loadGatewayStartupConfigSnapshot(startupParams);
      const reloadSource = { ...sourceConfig, logging: { level: "debug" as const } };
      const reload = resolveGatewayReloadPluginActivationCandidate({
        sourceConfig: reloadSource,
        env: process.env,
        manifestRegistry: metadata.manifestRegistry,
        ambientEnvTriggers,
      });

      for (const config of [startup.snapshot.config, reload]) {
        expect(config.channels?.discord?.enabled === true).toBe(enabled);
        expect(
          listGatewayActivatedChannelIds({
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
    expect(listGatewayActivatedChannelIds({ ...params, ambientEnvTriggers: "suppress" })).toEqual(
      [],
    );
  });
});
