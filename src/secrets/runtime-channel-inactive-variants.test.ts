/** Tests inactive channel variants in secrets runtime collection. */
import { describe, expect, it } from "vitest";
import "./runtime-channel-inactive-variants.test-support.ts";
import { getPath } from "./path-utils.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function prepare(channels: unknown, env: Record<string, string> = {}) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels }),
    env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
  });
}

describe("secrets runtime snapshot channel inactive variants", () => {
  it.each([
    {
      mode: "socket",
      credentials: { botToken: envRef("SLACK_BOT"), appToken: envRef("SLACK_APP") },
      resolved: { botToken: "xoxb-default", appToken: "xapp-default" },
    },
    {
      mode: "http",
      credentials: { botToken: envRef("SLACK_BOT"), signingSecret: envRef("SLACK_SIGNING") },
      resolved: { botToken: "xoxb-default", signingSecret: "signing-default" },
    },
    {
      mode: "relay",
      credentials: {
        botToken: envRef("SLACK_BOT"),
        relay: {
          url: "https://relay.example.invalid",
          gatewayId: "fixture",
          authToken: envRef("SLACK_RELAY"),
        },
      },
      resolved: { botToken: "xoxb-default", relay: { authToken: "relay-default" } },
    },
    {
      mode: "socket",
      credentials: {
        postAs: "user",
        userToken: envRef("SLACK_USER"),
        appToken: envRef("SLACK_APP"),
      },
      resolved: { userToken: "xoxp-default", appToken: "xapp-default" },
    },
  ])(
    "resolves the implicit Slack default's credentials in $mode mode",
    async ({ mode, credentials, resolved }) => {
      const snapshot = await prepare(
        {
          slack: {
            mode,
            ...credentials,
            accounts: {
              work: {
                mode: "socket",
                botToken: "xoxb-work",
                appToken: "xapp-work",
                userToken: "xoxp-work",
                signingSecret: "signing-work",
                relay: { authToken: "relay-work" },
              },
            },
          },
        },
        {
          SLACK_BOT: "xoxb-default",
          SLACK_APP: "xapp-default",
          SLACK_USER: "xoxp-default",
          SLACK_SIGNING: "signing-default",
          SLACK_RELAY: "relay-default",
        },
      );

      expect(snapshot.config.channels?.slack).toMatchObject(resolved);
      expect(snapshot.warnings).toEqual([]);
    },
  );

  it.each([
    { name: "explicit default", enabled: true, appToken: "xapp-default", accountId: "default" },
    {
      name: "case-insensitive default",
      enabled: true,
      appToken: "xapp-default",
      accountId: "Default",
    },
    { name: "normalized default", enabled: true, appToken: "xapp-default", accountId: " default " },
    { name: "disabled channel", enabled: false, appToken: "xapp-default", accountId: "work" },
    {
      name: "incomplete socket credentials",
      enabled: true,
      appToken: undefined,
      accountId: "work",
    },
  ])(
    "keeps unused Slack root refs inactive with $name",
    async ({ enabled, appToken, accountId }) => {
      const snapshot = await prepare({
        slack: {
          enabled,
          botToken: envRef("MISSING_SLACK_BOT"),
          appToken,
          accounts: { [accountId]: { botToken: "xoxb-work", appToken: "xapp-work" } },
        },
      });

      expect(snapshot.config.channels?.slack?.botToken).toEqual(envRef("MISSING_SLACK_BOT"));
      expect(snapshot.warnings).toContainEqual(
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "channels.slack.botToken",
        }),
      );
    },
  );

  it.each(["channel", "account"])("ignores disabled IRC %s nickserv", async (scope) => {
    const nickserv = {
      enabled: false,
      password: envRef(
        scope === "channel"
          ? "MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD"
          : "MISSING_IRC_WORK_NICKSERV_PASSWORD",
      ),
    };
    const irc =
      scope === "channel" ? { nickserv } : { accounts: { work: { enabled: true, nickserv } } };
    const snapshot = await prepare({ irc });
    const path = `channels.irc.${scope === "account" ? "accounts.work." : ""}nickserv.password`;
    expect(getPath(snapshot.config, path.split("."))).toEqual(nickserv.password);
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(path);
  });

  it.each([
    ["socket", "signingSecret"],
    ["http", "appToken"],
  ])("ignores Slack %s-inactive %s", async (mode, field) => {
    const ref = envRef(
      field === "appToken" ? "MISSING_SLACK_APP_TOKEN" : "MISSING_SLACK_SIGNING_SECRET",
    );
    const workRef = envRef("MISSING_SLACK_WORK_APP_TOKEN");
    const snapshot = await prepare({
      slack: {
        mode,
        [field]: ref,
        accounts: {
          work: { enabled: true, mode, ...(field === "appToken" ? { [field]: workRef } : {}) },
        },
      },
    });
    const paths = [
      `channels.slack.${field}`,
      ...(field === "appToken" ? [`channels.slack.accounts.work.${field}`] : []),
    ];
    for (const path of paths) {
      expect(getPath(snapshot.config, path.split("."))).toEqual(
        path.includes("accounts.work") ? workRef : ref,
      );
      expect(snapshot.warnings.map((warning) => warning.path)).toContain(path);
    }
  });

  it.each([
    {
      channel: "googlechat",
      root: { serviceAccount: envRef("GOOGLECHAT_DEFAULT") },
      work: { serviceAccount: "work-service-account-json" },
      resolved: { serviceAccount: "default-service-account-json" },
    },
    {
      channel: "mattermost",
      root: {
        baseUrl: "https://mattermost.example.invalid",
        botToken: envRef("MATTERMOST_DEFAULT"),
      },
      work: { baseUrl: "https://work.example.invalid", botToken: "work-bot-token" },
      resolved: { botToken: "default-bot-token" },
    },
    {
      channel: "x",
      root: {
        clientId: "fixture-client",
        clientSecret: envRef("X_CLIENT_SECRET"),
        refreshToken: envRef("X_REFRESH_TOKEN"),
      },
      work: {
        clientSecret: "work-secret",
        refreshToken: "work-refresh",
        bearerToken: "work-bearer",
      },
      resolved: { clientSecret: "default-client-secret", refreshToken: "default-refresh-token" },
    },
  ])(
    "resolves the implicit $channel default's credentials when named accounts override them",
    async ({ channel, root, work, resolved }) => {
      const snapshot = await prepare(
        { [channel]: { ...root, accounts: { work: { enabled: true, ...work } } } },
        {
          GOOGLECHAT_DEFAULT: "default-service-account-json",
          MATTERMOST_DEFAULT: "default-bot-token",
          X_CLIENT_SECRET: "default-client-secret",
          X_REFRESH_TOKEN: "default-refresh-token",
        },
      );

      expect(getPath(snapshot.config, ["channels", channel])).toMatchObject(resolved);
      expect(snapshot.warnings).toEqual([]);
    },
  );

  it.each([
    {
      name: "an explicit default override",
      accountId: "default",
      baseUrl: "https://mattermost.example.invalid",
    },
    { name: "no root base URL", accountId: "work", baseUrl: undefined },
  ])("keeps unused Mattermost root refs inactive with $name", async ({ accountId, baseUrl }) => {
    const botToken = envRef("MISSING_MATTERMOST_DEFAULT");
    const snapshot = await prepare({
      mattermost: {
        baseUrl,
        botToken,
        accounts: {
          [accountId]: { baseUrl: "https://work.example.invalid", botToken: "work-bot-token" },
        },
      },
    });

    expect(getPath(snapshot.config, ["channels", "mattermost", "botToken"])).toEqual(botToken);
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.mattermost.botToken",
      }),
    );
  });

  it("keeps top-level Google Chat serviceAccount inactive when an explicit default overrides it", async () => {
    const snapshot = await prepare(
      {
        googlechat: {
          serviceAccount: envRef("MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT"),
          accounts: {
            default: {
              enabled: true,
              serviceAccount: envRef("GOOGLECHAT_DEFAULT_SERVICE_ACCOUNT"),
            },
          },
        },
      },
      { GOOGLECHAT_DEFAULT_SERVICE_ACCOUNT: "default-service-account-json" },
    );

    expect(snapshot.config.channels?.googlechat?.serviceAccount).toEqual(
      envRef("MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT"),
    );
    expect(snapshot.config.channels?.googlechat?.accounts?.default?.serviceAccount).toBe(
      "default-service-account-json",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.googlechat.serviceAccount",
    );
  });
});
