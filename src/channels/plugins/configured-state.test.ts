// Configured state tests cover channel plugin configured-state detection and summaries.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasBundledChannelPackageState } from "./package-state-probes.js";

describe("bundled channel configured-state metadata", () => {
  it("resolves Discord, Slack, Telegram, and IRC env probes without full plugin loads", () => {
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "discord",
        cfg: {},
        env: { DISCORD_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "slack",
        cfg: {},
        env: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "telegram",
        cfg: {},
        env: { TELEGRAM_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "irc",
        cfg: {},
        env: { IRC_HOST: "irc.example.com", IRC_NICK: "openclaw" },
      }),
    ).toBe(true);
  });

  it.each([
    { channelId: "nextcloud-talk", env: { NEXTCLOUD_TALK_BOT_SECRET: "secret" } },
    { channelId: "zalo", env: { ZALO_WEBHOOK_SECRET: "secret" } },
  ])("rejects incomplete $channelId environment credentials", ({ channelId, env }) => {
    expect(
      hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg: {}, env }),
    ).toBe(false);
  });

  it("keeps explicit blank Teams credentials authoritative over ambient credentials", () => {
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "msteams",
        cfg: { channels: { msteams: { appId: "", appPassword: "", tenantId: "" } } },
        env: {
          MSTEAMS_APP_ID: "ambient-app",
          MSTEAMS_APP_PASSWORD: "ambient-password",
          MSTEAMS_TENANT_ID: "ambient-tenant",
        },
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "configured Nextcloud account",
      channelId: "nextcloud-talk",
      cfg: { channels: { "nextcloud-talk": { baseUrl: "https://cloud.example.test" } } },
      env: { NEXTCLOUD_TALK_BOT_SECRET: "secret" },
    },
  ] satisfies Array<{
    name: string;
    channelId: string;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
  }>)("accepts the owner-specific $name contract", ({ channelId, cfg, env }) => {
    expect(
      hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg, env }),
    ).toBe(true);
  });
});
