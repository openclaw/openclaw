import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import { stableWhatsAppConfig } from "./update-cli/update-cli-config.test-support.js";
import { writeJsonFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const f = createUpdateCliFixture();

it("restores pre-update channel model overrides when post-core resume restores a channel", async () => {
  const updateStartedAtMs = Date.now();
  const channelConfig = stableWhatsAppConfig();
  const telegram = { enabled: true };
  const modelByChannel = { openai: { whatsapp: "openai/gpt-5.5", telegram: "openai/gpt-5.4" } };
  const preUpdateConfig = {
    ...channelConfig,
    channels: { ...channelConfig.channels, telegram, modelByChannel },
  } as OpenClawConfig;
  const postDoctorConfig = {
    update: { channel: "stable" },
    channels: { telegram, modelByChannel: { openai: { telegram: "openai/gpt-5.4" } } },
  } as OpenClawConfig;
  await f.setupPostCoreConfigFixture({ preUpdateConfig, postDoctorConfig });

  await f.runPostCoreUpdate({ OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs) });

  const restored = { channels: { modelByChannel } };
  expect(checks.syncPluginCall()?.config).toMatchObject(restored);
  expect(checks.lastReplaceConfigCall()?.nextConfig).toMatchObject(restored);
});

it.each(["payload", "included-backup"] as const)(
  "restores authored channel values from %s",
  async (source) => {
    const tempDir = f.createCaseDir("openclaw-update");
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const configPath = path.join(tempDir, "openclaw.json");
    const updateStartedAtMs = Date.now();
    const authoredChannels = { whatsapp: { enabled: true, token: "${WHATSAPP_TOKEN}" } };
    await fs.mkdir(tempDir, { recursive: true });
    if (source === "payload") {
      await writeJsonFixture(sourceConfigPath, {
        sourceConfig: {
          update: { channel: "stable" },
          channels: { whatsapp: { enabled: true, token: "resolved-secret" } },
        },
        authoredConfig: { update: { channel: "stable" }, channels: authoredChannels },
      });
      const postDoctorConfig = {
        update: { channel: "stable" },
        meta: { lastTouchedVersion: "2026.5.14" },
      } satisfies OpenClawConfig;
      vi.mocked(cli.readConfigFileSnapshot).mockResolvedValue({
        ...f.baseSnapshot,
        sourceConfig: postDoctorConfig,
        config: postDoctorConfig,
        runtimeConfig: postDoctorConfig,
        hash: "post-doctor-hash",
      });
    } else {
      const postDoctorConfig = {
        update: { channel: "stable" },
        channels: {},
      } satisfies OpenClawConfig;
      await writeJsonFixture(path.join(tempDir, "channels.json5"), authoredChannels);
      await writeJsonFixture(`${configPath}.bak`, {
        update: { channel: "stable" },
        channels: { $include: "./channels.json5" },
      });
      await writeJsonFixture(configPath, postDoctorConfig);
      f.mockPostDoctorSnapshot(configPath, postDoctorConfig);
    }
    f.mockNoopPostUpdatePluginConvergence();

    await f.runPostCoreUpdate(
      source === "payload"
        ? {
            OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath,
            OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: undefined,
          }
        : {
            WHATSAPP_TOKEN: "resolved-token",
            OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(updateStartedAtMs),
          },
    );

    expect(checks.syncPluginCall()?.config).toMatchObject({
      channels: {
        whatsapp: { token: source === "payload" ? "resolved-secret" : "resolved-token" },
      },
    });
    if (source === "payload") {
      expect(checks.lastReplaceConfigCall()?.nextConfig).toMatchObject({
        channels: { whatsapp: { token: "${WHATSAPP_TOKEN}" } },
      });
    } else {
      expect(checks.lastReplaceConfigCall()?.nextConfig?.channels).toEqual({
        $include: "./channels.json5",
      });
    }
  },
);
