// Exercise Slack's real read-only inspector through the production status table.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SlackAccountConfig } from "../../config/types.slack.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { buildChannelsTable } from "./channels.js";

const discovery = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("../../channels/plugins/read-only.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/read-only.js")>()),
  resolveReadOnlyChannelPluginsForConfig: discovery.resolve,
}));

beforeAll(async () => {
  const { inspectSlackReadOnlyAccount } = await loadBundledPluginFacade<{
    inspectSlackReadOnlyAccount: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
  }>({ pluginId: "slack", artifactBasename: "account-inspect-api.ts" });
  // Replace discovery only; account inspection, snapshot projection and reporting stay real.
  discovery.resolve.mockReturnValue({
    plugins: [
      {
        id: "slack",
        meta: { label: "Slack" },
        config: {
          listAccountIds: (cfg: OpenClawConfig) => Object.keys(cfg.channels?.slack?.accounts ?? {}),
          inspectAccount: inspectSlackReadOnlyAccount,
        },
      },
    ],
    manifestRecords: [],
    configuredChannelIds: ["slack"],
    missingConfiguredChannelIds: [],
    loadFailures: [],
  });
});

beforeEach(() => {
  vi.stubEnv("SLACK_BOT_TOKEN", "");
  vi.stubEnv("SLACK_APP_TOKEN", "");
  vi.stubEnv("SLACK_USER_TOKEN", "");
});
afterEach(() => vi.unstubAllEnvs());

const userToken = "xoxp-synthetic-user-credential";
const botToken = "xoxb-synthetic-bot-credential";
const appToken = "xapp-synthetic-app-credential";
const signingSecret = "synthetic-signing-credential"; // pragma: allowlist secret
const secretRef = { source: "env", provider: "default", id: "SLACK_TEST_SECRET" } as const;
const relay = {
  url: "wss://relay.example.test",
  authToken: "synthetic-relay-credential",
  gatewayId: "test-gateway",
};

async function tableFor(
  accounts: Record<string, SlackAccountConfig>,
  opts?: Parameters<typeof buildChannelsTable>[1],
) {
  return buildChannelsTable({ channels: { slack: { enabled: true, accounts } } }, opts);
}

const transports = [
  { mode: "socket", credentials: { appToken }, secondary: "app" },
  { mode: "http", credentials: { signingSecret }, secondary: "signing" },
] as const;

describe("Slack status credential summaries", () => {
  for (const { mode, credentials, secondary } of transports) {
    it.each(["bot", "user"] as const)(
      `reports a configured %s identity in ${mode} mode`,
      async (postAs) => {
        const token = postAs === "user" ? { userToken } : { botToken };
        const table = await tableFor({ primary: { mode, postAs, ...token, ...credentials } });
        expect(table.rows[0]).toMatchObject({ id: "slack", state: "ok" });
        expect(table.rows[0]?.detail).toContain(`${postAs} config, ${secondary} config`);
        expect(table.rows[0]?.detail).toContain("accounts 1/1");
        expect(table.details[0]?.rows[0]?.Status).toBe("OK");
        expect(table.details[0]?.rows[0]?.Notes).toContain(`${postAs}:config`);
        for (const value of [userToken, botToken, appToken, signingSecret]) {
          expect(JSON.stringify(table)).not.toContain(value);
        }
      },
    );

    it(`names the user credential when the ${mode} identity token is missing`, async () => {
      const table = await tableFor({ primary: { mode, postAs: "user", botToken, ...credentials } });
      expect(table.rows[0]).toMatchObject({ state: "warn" });
      expect(table.rows[0]?.detail).toContain(`need user+${secondary}`);
      expect(table.details).toEqual([]);
    });

    it(`still requires the ${mode} transport credential`, async () => {
      const table = await tableFor({ primary: { mode, postAs: "user", userToken } });
      expect(table.rows[0]).toMatchObject({ state: "warn" });
      expect(table.rows[0]?.detail).toContain(`need user+${secondary}`);
      expect(table.details).toEqual([]);
    });

    it(`preserves unavailable ${mode} credentials and reconciles live gateway availability`, async () => {
      const accounts = {
        primary: { mode, postAs: "user" as const, userToken: secretRef, ...credentials },
      };
      const unavailable = await tableFor(accounts);
      expect(unavailable.rows[0]).toMatchObject({ state: "warn" });
      expect(unavailable.rows[0]?.detail).toContain("unavailable");
      expect(unavailable.details[0]?.rows[0]?.Status).toBe("WARN");

      const live = await tableFor(accounts, {
        liveChannelStatus: {
          channelAccounts: { slack: [{ accountId: "primary", running: true, connected: true }] },
        },
      });
      expect(live.rows[0]).toMatchObject({ state: "ok" });
      expect(live.rows[0]?.detail).not.toContain("unavailable");
      expect(live.details[0]?.rows[0]).toMatchObject({
        Status: "OK",
        Notes: expect.stringContaining("credential available in gateway runtime"),
      });
    });
  }

  it("summarizes mixed transports and identities by their own requirements", async () => {
    const table = await tableFor({
      http: { mode: "http", postAs: "user", userToken, signingSecret },
      socket: { mode: "socket", botToken, appToken },
      relay: { mode: "relay", botToken, relay },
    });
    expect(table.rows[0]).toMatchObject({ state: "ok" });
    expect(table.rows[0]?.detail).toContain("user config, signing config");
    expect(table.rows[0]?.detail).toContain("bot config, app config");
    expect(table.details[0]?.rows.map((row) => row.Status)).toEqual(["OK", "OK", "OK"]);
  });

  it("keeps bot and user identities separate within the same transport", async () => {
    const table = await tableFor({
      bot: { botToken, appToken },
      user: { postAs: "user", userToken, appToken },
    });
    expect(table.rows[0]).toMatchObject({ state: "ok" });
    expect(table.rows[0]?.detail).toContain("bot config, app config");
    expect(table.rows[0]?.detail).toContain("user config, app config");
  });

  it("does not hide an incomplete account behind a healthy account of another mode", async () => {
    const table = await tableFor({
      http: { mode: "http", postAs: "user", userToken },
      socket: { mode: "socket", botToken, appToken },
    });
    expect(table.rows[0]).toMatchObject({ state: "warn" });
    expect(table.rows[0]?.detail).toContain("need user+signing");
  });

  it.each([
    { name: "relay", incomplete: { mode: "relay", botToken } },
    { name: "user identity", incomplete: { postAs: "user", botToken } },
  ] satisfies Array<{ name: string; incomplete: SlackAccountConfig }>)(
    "keeps incomplete $name configuration visible beside a healthy account",
    async ({ incomplete }) => {
      const table = await tableFor({
        healthy: { botToken, appToken },
        incomplete,
      });
      expect(table.rows[0]).toMatchObject({ state: "warn" });
    },
  );

  it("keeps incomplete relay configuration visible within the same mode", async () => {
    const table = await tableFor({
      healthy: { mode: "relay", botToken, relay },
      incomplete: { mode: "relay", botToken },
    });
    expect(table.rows[0]).toMatchObject({ state: "warn" });
  });

  it("keeps missing user credentials visible within the same identity and transport", async () => {
    const table = await tableFor({
      healthy: { postAs: "user", userToken, appToken },
      incomplete: { postAs: "user", botToken },
    });
    expect(table.rows[0]).toMatchObject({ state: "warn" });
  });

  it("reports setup when every identity group is unconfigured", async () => {
    const table = await tableFor({ bot: {}, user: { postAs: "user" } });
    expect(table.rows[0]).toMatchObject({ state: "setup" });
  });

  it("uses plugin readiness for relay configuration without requiring an app token", async () => {
    const configured = await tableFor({ primary: { mode: "relay", botToken, relay } });
    expect(configured.rows[0]).toMatchObject({ state: "ok" });
    expect(configured.rows[0]?.detail).not.toContain("app");
    const incomplete = await tableFor({ primary: { mode: "relay", botToken } });
    expect(incomplete.rows[0]).toMatchObject({ state: "setup" });
    expect(incomplete.rows[0]?.detail).not.toContain("app");
    expect(incomplete.details).toEqual([]);
  });

  it.each(["bot", "user"] as const)(
    "reports the selected %s relay identity's environment fallback source",
    async (postAs) => {
      vi.stubEnv(
        postAs === "user" ? "SLACK_USER_TOKEN" : "SLACK_BOT_TOKEN",
        postAs === "user" ? userToken : botToken,
      );
      const otherToken = postAs === "user" ? { botToken } : { userToken };
      const table = await tableFor({ default: { mode: "relay", postAs, relay, ...otherToken } });
      expect(table.rows[0]).toMatchObject({ state: "ok" });
      expect(table.rows[0]?.detail).toContain(`${postAs} token env`);
      expect(table.details[0]?.rows[0]?.Notes).toContain(`${postAs}:env`);
      expect(JSON.stringify(table)).not.toContain(userToken);
      expect(JSON.stringify(table)).not.toContain(botToken);
    },
  );

  it.each(["bot", "user"] as const)(
    "keeps explicit %s relay credentials authoritative over environment fallback",
    async (postAs) => {
      vi.stubEnv(postAs === "user" ? "SLACK_USER_TOKEN" : "SLACK_BOT_TOKEN", "synthetic-env-token");
      const token = postAs === "user" ? { userToken } : { botToken };
      const table = await tableFor({ default: { mode: "relay", postAs, relay, ...token } });
      expect(table.rows[0]).toMatchObject({ state: "ok" });
      expect(table.rows[0]?.detail).toContain(`${postAs} token config`);
      expect(table.details[0]?.rows[0]?.Notes).toContain(`${postAs}:config`);
    },
  );

  it("ignores disabled accounts when selecting credential requirements", async () => {
    const table = await tableFor({
      active: { postAs: "user", userToken, appToken },
      disabled: { enabled: false, mode: "http", botToken: secretRef },
    });
    expect(table.rows[0]).toMatchObject({ state: "ok" });
    expect(table.rows[0]?.detail).toContain("accounts 1/1");
    expect(table.details[0]?.rows).toHaveLength(1);
  });

  it("does not treat the optional user token as the selected bot identity", async () => {
    const table = await tableFor({ primary: { userToken, appToken } });
    expect(table.rows[0]).toMatchObject({ state: "warn" });
    expect(table.rows[0]?.detail).toContain("need bot+app");
  });
});
