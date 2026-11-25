import { expect, it } from "vitest";
import "./runtime-channel-inactive-variants.test-support.ts";
import { getPath } from "./path-utils.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const ref = (id = "KEY") => ({ source: "env", provider: "default", id }) as const;
const missing = ref("MISSING");
const work = {
  mode: "socket",
  botToken: "bot",
  appToken: "app",
  userToken: "user",
  signingSecret: "signing",
  relay: { authToken: "relay" },
};
function prepare(channel: string, config: Record<string, unknown>, env = {}) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels: { [channel]: config } }),
    env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
  });
}
function expectInactive(
  snapshot: Awaited<ReturnType<typeof prepare>>,
  channel: string,
  field: string,
  value = missing,
) {
  const path = `channels.${channel}.${field}`;
  expect(getPath(snapshot.config, path.split("."))).toEqual(value);
  expect(snapshot.warnings).toContainEqual(
    expect.objectContaining({ code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE", path }),
  );
}

it.each([
  ["socket", "botToken", "appToken"],
  ["http", "botToken", "signingSecret"],
  ["socket", "userToken", "appToken"],
] as const)("resolves implicit Slack %s credentials for %s", async (mode, token, transport) => {
  const snapshot = await prepare(
    "slack",
    {
      mode,
      [token]: ref(),
      [transport]: ref("TRANSPORT"),
      ...(token === "userToken" ? { postAs: "user" } : {}),
      accounts: { work },
    },
    { KEY: "resolved-token", TRANSPORT: "resolved-transport" },
  );
  expect(snapshot.config.channels?.slack).toMatchObject({
    [token]: "resolved-token",
    [transport]: "resolved-transport",
  });
  expect(snapshot.warnings).toEqual([]);
});

it("resolves implicit Slack relay credentials", async () => {
  const snapshot = await prepare(
    "slack",
    {
      mode: "relay",
      botToken: ref(),
      relay: { url: "https://relay.test", gatewayId: "fixture", authToken: ref("RELAY") },
      accounts: { work },
    },
    { KEY: "bot", RELAY: "relay" },
  );
  expect(snapshot.config.channels?.slack).toMatchObject({
    botToken: "bot",
    relay: { authToken: "relay" },
  });
  expect(snapshot.warnings).toEqual([]);
});

it.each([
  [
    "googlechat",
    { serviceAccount: ref() },
    { serviceAccount: "work" },
    { serviceAccount: "resolved" },
  ],
  [
    "mattermost",
    { baseUrl: "https://root.test", botToken: ref() },
    { baseUrl: "https://work.test", botToken: "work" },
    { botToken: "resolved" },
  ],
  [
    "x",
    { clientId: "client", clientSecret: ref(), refreshToken: ref("TOKEN") },
    { clientSecret: "work", refreshToken: "work", bearerToken: "work" },
    { clientSecret: "resolved", refreshToken: "token" },
  ],
] as const)(
  "resolves implicit %s credentials despite named overrides",
  async (channel, root, account, expected) => {
    const snapshot = await prepare(
      channel,
      { ...root, accounts: { work: { enabled: true, ...account } } },
      { KEY: "resolved", TOKEN: "token" },
    );
    expect(getPath(snapshot.config, ["channels", channel])).toMatchObject(expected);
    expect(snapshot.warnings).toEqual([]);
  },
);

it.each([
  [" Default ", true, "app"],
  ["work", false, "app"],
  ["work", true, undefined],
] as const)(
  "keeps Slack root inactive: account=%s enabled=%s app=%s",
  async (accountId, enabled, appToken) => {
    const snapshot = await prepare("slack", {
      enabled,
      botToken: missing,
      appToken,
      accounts: { [accountId]: { botToken: "bot", appToken: "app" } },
    });
    expectInactive(snapshot, "slack", "botToken");
  },
);

it.each(["channel", "account"])("ignores disabled IRC %s nickserv", async (scope) => {
  const nickserv = { enabled: false, password: missing };
  const config =
    scope === "channel" ? { nickserv } : { accounts: { work: { enabled: true, nickserv } } };
  expectInactive(
    await prepare("irc", config),
    "irc",
    `${scope === "account" ? "accounts.work." : ""}nickserv.password`,
  );
});

it.each([
  ["socket", "signingSecret"],
  ["http", "appToken"],
])("ignores Slack %s-inactive %s", async (mode, field) => {
  const workRef = ref("MISSING_WORK");
  const snapshot = await prepare("slack", {
    mode,
    [field]: missing,
    accounts: {
      work: { enabled: true, mode, ...(field === "appToken" ? { [field]: workRef } : {}) },
    },
  });
  expectInactive(snapshot, "slack", field);
  if (field === "appToken") {
    expectInactive(snapshot, "slack", `accounts.work.${field}`, workRef);
  }
});

it.each([
  ["default", "https://root.test"],
  ["work", undefined],
] as const)("keeps Mattermost root inactive: account=%s baseUrl=%s", async (accountId, baseUrl) => {
  const snapshot = await prepare("mattermost", {
    baseUrl,
    botToken: missing,
    accounts: { [accountId]: { baseUrl: "https://work.test", botToken: "work" } },
  });
  expectInactive(snapshot, "mattermost", "botToken");
});

it("resolves explicit Google Chat default without resolving the overridden root", async () => {
  const snapshot = await prepare(
    "googlechat",
    { serviceAccount: missing, accounts: { default: { enabled: true, serviceAccount: ref() } } },
    { KEY: "resolved" },
  );
  expectInactive(snapshot, "googlechat", "serviceAccount");
  expect(snapshot.config.channels?.googlechat?.accounts?.default?.serviceAccount).toBe("resolved");
});
