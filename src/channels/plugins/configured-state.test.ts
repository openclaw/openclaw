// Configured state tests cover channel plugin configured-state detection and summaries.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  hasBundledChannelConfiguredState,
  listBundledChannelIdsWithConfiguredState,
} from "./configured-state.js";

const nodeRequire = createRequire(import.meta.url);

describe("bundled channel configured-state metadata", () => {
  it("lists the shipped metadata-first configured-state channels", () => {
    expect(listBundledChannelIdsWithConfiguredState()).toEqual([
      "buzz",
      "clickclack",
      "discord",
      "feishu",
      "googlechat",
      "irc",
      "line",
      "matrix",
      "mattermost",
      "msteams",
      "nextcloud-talk",
      "nostr",
      "qqbot",
      "raft",
      "slack",
      "sms",
      "synology-chat",
      "telegram",
      "twitch",
      "zalo",
      "zalouser",
    ]);
  });

  it("resolves Discord, Slack, Telegram, and IRC env probes without full plugin loads", () => {
    expect(
      hasBundledChannelConfiguredState({
        channelId: "discord",
        cfg: {},
        env: { DISCORD_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelConfiguredState({
        channelId: "slack",
        cfg: {},
        env: { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelConfiguredState({
        channelId: "slack",
        cfg: { channels: { slack: { identity: "user" } } },
        env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      }),
    ).toBe(false);
    expect(
      hasBundledChannelConfiguredState({
        channelId: "slack",
        cfg: { channels: { slack: { postAs: "user" } } },
        env: { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
      }),
    ).toBe(true);
    for (const env of [
      { SLACK_APP_TOKEN: "xapp-test" },
      { SLACK_BOT_TOKEN: "xoxb-test" },
      { SLACK_USER_TOKEN: "xoxp-test" },
      { SLACK_APP_TOKEN: "xapp-test", SLACK_USER_TOKEN: "xoxp-test" },
    ]) {
      expect(
        hasBundledChannelConfiguredState({
          channelId: "slack",
          cfg: {},
          env,
        }),
      ).toBe(false);
    }
    expect(
      hasBundledChannelConfiguredState({
        channelId: "telegram",
        cfg: {},
        env: { TELEGRAM_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelConfiguredState({
        channelId: "irc",
        cfg: {},
        env: { IRC_HOST: "irc.example.com", IRC_NICK: "openclaw" },
      }),
    ).toBe(true);
  });

  it("requires a Slack bot token for relay transport even with user identity", () => {
    const cfg = {
      channels: {
        slack: {
          mode: "relay" as const,
          postAs: "user" as const,
          relay: {
            url: "https://relay.example.com",
            authToken: "relay-token",
            gatewayId: "relay-gateway",
          },
        },
      },
    };

    expect(
      hasBundledChannelConfiguredState({
        channelId: "slack",
        cfg,
        env: { SLACK_USER_TOKEN: "xoxp-test" },
      }),
    ).toBe(false);
    expect(
      hasBundledChannelConfiguredState({
        channelId: "slack",
        cfg,
        env: { SLACK_USER_TOKEN: "xoxp-test", SLACK_BOT_TOKEN: "xoxb-test" },
      }),
    ).toBe(true);
  });

  it("recognizes outbound-ready SMS without requiring an inbound webhook or opt-out", () => {
    const requiredEnv = {
      TWILIO_ACCOUNT_SID: "AC-test",
      TWILIO_AUTH_TOKEN: "twilio-test-token",
      TWILIO_PHONE_NUMBER: "+15550001111",
    };

    for (const { env, configured } of [
      {
        env: { ...requiredEnv, SMS_PUBLIC_WEBHOOK_URL: "https://sms.example.com/webhook" },
        configured: true,
      },
      {
        env: { ...requiredEnv, SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "true" },
        configured: true,
      },
      { env: requiredEnv, configured: true },
      {
        env: { ...requiredEnv, SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: "false" },
        configured: true,
      },
      {
        env: { ...requiredEnv, SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION: " true " },
        configured: true,
      },
    ]) {
      expect(hasBundledChannelConfiguredState({ channelId: "sms", cfg: {}, env })).toBe(configured);
    }
  });

  it.each([
    {
      label: "default client-secret authentication",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_APP_PASSWORD: "teams-secret",
      },
      configured: true,
    },
    {
      label: "a federated certificate",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_CERTIFICATE_PATH: "/teams.pem",
      },
      configured: true,
    },
    {
      label: "a whitespace-only federated certificate",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_CERTIFICATE_PATH: "   ",
      },
      configured: false,
    },
    {
      label: "an enabled federated managed identity",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
      configured: true,
    },
    {
      label: "a certificate without federated mode",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_CERTIFICATE_PATH: "/teams.pem",
      },
      configured: false,
    },
    {
      label: "a managed identity without federated mode",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
      configured: false,
    },
    {
      label: "a disabled federated managed identity",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_USE_MANAGED_IDENTITY: "false",
      },
      configured: false,
    },
    {
      label: "federated mode without an authentication mechanism",
      env: {
        MSTEAMS_APP_ID: "teams-app",
        MSTEAMS_TENANT_ID: "teams-tenant",
        MSTEAMS_AUTH_TYPE: "federated",
      },
      configured: false,
    },
  ])("checks Teams $label through its lightweight owner module", ({ env, configured }) => {
    expect(
      hasBundledChannelConfiguredState({
        channelId: "msteams",
        cfg: {},
        env,
      }),
    ).toBe(configured);
  });

  it("uses declarative env metadata without a TypeScript source require hook", () => {
    const previousTsHook = nodeRequire.extensions[".ts"];
    delete nodeRequire.extensions[".ts"];
    try {
      expect(
        hasBundledChannelConfiguredState({
          channelId: "discord",
          cfg: {},
          env: { DISCORD_BOT_TOKEN: "token" },
        }),
      ).toBe(true);
    } finally {
      if (previousTsHook) {
        nodeRequire.extensions[".ts"] = previousTsHook;
      }
    }
  });
});
