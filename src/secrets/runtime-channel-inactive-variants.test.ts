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

  it.each([
    {
      channel: "googlechat",
      root: { serviceAccount: envRef("GOOGLECHAT_DEFAULT") },
      work: { serviceAccount: "work-service-account-json" },
      resolved: { serviceAccount: "default-service-account-json" },
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
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          channels: { [channel]: { ...root, accounts: { work: { enabled: true, ...work } } } },
        }),
        env: {
          GOOGLECHAT_DEFAULT: "default-service-account-json",
          X_CLIENT_SECRET: "default-client-secret",
          X_REFRESH_TOKEN: "default-refresh-token",
        },
        agentDirs: ["/tmp/openclaw-agent-main"],
        loadAuthStore: () => loadAuthStoreWithProfiles({}),
      });
      expect(snapshot.config.channels?.[channel]).toMatchObject(resolved);
      expect(snapshot.warnings).toEqual([]);
    },
  );

  it("keeps top-level Google Chat serviceAccount inactive when an explicit default overrides it", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
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
      }),
      env: {
        GOOGLECHAT_DEFAULT_SERVICE_ACCOUNT: "default-service-account-json",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

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
