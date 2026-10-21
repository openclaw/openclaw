/** Tests inactive channel variants in secrets runtime collection. */
import { describe, expect, it } from "vitest";
import "./runtime-channel-inactive-variants.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function envRef(id: string) {
  return { source: "env", provider: "default", id } as const;
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
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
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
        }),
        env: {
          SLACK_BOT: "xoxb-default",
          SLACK_APP: "xapp-default",
          SLACK_USER: "xoxp-default",
          SLACK_SIGNING: "signing-default",
          SLACK_RELAY: "relay-default",
        },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      });

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
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: {
            slack: {
              enabled,
              botToken: envRef("MISSING_SLACK_BOT"),
              appToken,
              accounts: { [accountId]: { botToken: "xoxb-work", appToken: "xapp-work" } },
            },
          },
        }),
        env: {},
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
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

  it("treats IRC account nickserv password refs as inactive when nickserv is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          irc: {
            accounts: {
              work: {
                enabled: true,
                nickserv: {
                  enabled: false,
                  password: envRef("MISSING_IRC_WORK_NICKSERV_PASSWORD"),
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.irc?.accounts?.work?.nickserv?.password).toEqual(
      envRef("MISSING_IRC_WORK_NICKSERV_PASSWORD"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.irc.accounts.work.nickserv.password",
    );
  });

  it("treats top-level IRC nickserv password refs as inactive when nickserv is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          irc: {
            nickserv: {
              enabled: false,
              password: envRef("MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD"),
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.irc?.nickserv?.password).toEqual(
      envRef("MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.irc.nickserv.password",
    );
  });

  it("treats Slack signingSecret refs as inactive when mode is socket", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          slack: {
            mode: "socket",
            signingSecret: envRef("MISSING_SLACK_SIGNING_SECRET"),
            accounts: {
              work: {
                enabled: true,
                mode: "socket",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.slack?.signingSecret).toEqual(
      envRef("MISSING_SLACK_SIGNING_SECRET"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.slack.signingSecret",
    );
  });

  it("treats Slack appToken refs as inactive when mode is http", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          slack: {
            mode: "http",
            appToken: envRef("MISSING_SLACK_APP_TOKEN"),
            accounts: {
              work: {
                enabled: true,
                mode: "http",
                appToken: envRef("MISSING_SLACK_WORK_APP_TOKEN"),
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.slack?.appToken).toEqual(envRef("MISSING_SLACK_APP_TOKEN"));
    expect(snapshot.config.channels?.slack?.accounts?.work?.appToken).toEqual(
      envRef("MISSING_SLACK_WORK_APP_TOKEN"),
    );
    const warningPaths = snapshot.warnings.map((warning) => warning.path);
    expect(warningPaths).toContain("channels.slack.appToken");
    expect(warningPaths).toContain("channels.slack.accounts.work.appToken");
  });

  it("treats top-level Google Chat serviceAccount as inactive when enabled accounts override it", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          googlechat: {
            serviceAccount: envRef("MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT"),
            accounts: {
              work: {
                enabled: true,
                serviceAccount: envRef("GOOGLECHAT_WORK_SERVICE_ACCOUNT"),
              },
            },
          },
        },
      }),
      env: {
        GOOGLECHAT_WORK_SERVICE_ACCOUNT: "work-service-account-json",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.googlechat?.serviceAccount).toEqual(
      envRef("MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT"),
    );
    expect(snapshot.config.channels?.googlechat?.accounts?.work?.serviceAccount).toBe(
      "work-service-account-json",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.googlechat.serviceAccount",
    );
  });
});
