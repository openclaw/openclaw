import { describe, expect, it, vi } from "vitest";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { makeDirectPlugin } from "../../test-utils/channel-plugin-test-fixtures.js";
import { buildChannelsTable } from "./channels.js";

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
}));

function makeMattermostPlugin(): ChannelPlugin {
  return {
    id: "mattermost",
    meta: {
      id: "mattermost",
      label: "Mattermost",
      selectionLabel: "Mattermost",
      docsPath: "/channels/mattermost",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["echo"],
      defaultAccountId: () => "echo",
      resolveAccount: () => ({
        name: "Echo",
        enabled: true,
        botToken: "bot-token-value",
        baseUrl: "https://mm.example.com",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      listActions: () => ["send"],
    },
  };
}

type TestTable = Awaited<ReturnType<typeof buildChannelsTable>>;

function makeSlackDirectPlugin(config: ChannelPlugin["config"]): ChannelPlugin {
  return makeDirectPlugin({
    id: "slack",
    label: "Slack",
    docsPath: "/channels/slack",
    config,
  });
}

function createSlackTokenAccount(params?: { botToken?: string; appToken?: string }) {
  return {
    name: "Primary",
    enabled: true,
    botToken: params?.botToken ?? "bot-token",
    appToken: params?.appToken ?? "app-token",
  };
}

function createUnavailableSlackTokenAccount() {
  return {
    name: "Primary",
    enabled: true,
    configured: true,
    botToken: "",
    appToken: "",
    botTokenSource: "config",
    appTokenSource: "config",
    botTokenStatus: "configured_unavailable",
    appTokenStatus: "configured_unavailable",
  };
}

function makeSlackPlugin(params?: { botToken?: string; appToken?: string }): ChannelPlugin {
  return makeSlackDirectPlugin({
    listAccountIds: () => ["primary"],
    defaultAccountId: () => "primary",
    inspectAccount: () => createSlackTokenAccount(params),
    resolveAccount: () => createSlackTokenAccount(params),
    isConfigured: () => true,
    isEnabled: () => true,
  });
}

function makeUnavailableSlackPlugin(): ChannelPlugin {
  return makeSlackDirectPlugin({
    listAccountIds: () => ["primary"],
    defaultAccountId: () => "primary",
    inspectAccount: () => createUnavailableSlackTokenAccount(),
    resolveAccount: () => createUnavailableSlackTokenAccount(),
    isConfigured: () => true,
    isEnabled: () => true,
  });
}

function makeSourceAwareUnavailablePlugin(): ChannelPlugin {
  return makeSlackDirectPlugin({
    listAccountIds: () => ["primary"],
    defaultAccountId: () => "primary",
    inspectAccount: (cfg) =>
      (cfg as { marker?: string }).marker === "source"
        ? createUnavailableSlackTokenAccount()
        : {
            name: "Primary",
            enabled: true,
            configured: false,
            botToken: "",
            appToken: "",
            botTokenSource: "none",
            appTokenSource: "none",
          },
    resolveAccount: () => ({
      name: "Primary",
      enabled: true,
      botToken: "",
      appToken: "",
    }),
    isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
    isEnabled: () => true,
  });
}

function makeSourceUnavailableResolvedAvailablePlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "discord",
    label: "Discord",
    docsPath: "/channels/discord",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: (cfg) =>
        (cfg as { marker?: string }).marker === "source"
          ? {
              name: "Primary",
              enabled: true,
              configured: true,
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            }
          : {
              name: "Primary",
              enabled: true,
              configured: true,
              tokenSource: "config",
              tokenStatus: "available",
            },
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
        tokenSource: "config",
        tokenStatus: "available",
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: () => true,
    },
  });
}

function makeHttpSlackUnavailablePlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "slack",
    label: "Slack",
    docsPath: "/channels/slack",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: () => ({
        accountId: "primary",
        name: "Primary",
        enabled: true,
        configured: true,
        mode: "http",
        botToken: "xoxb-http",
        signingSecret: "",
        botTokenSource: "config",
        signingSecretSource: "config", // pragma: allowlist secret
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      }),
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
        mode: "http",
        botToken: "xoxb-http",
        signingSecret: "",
        botTokenSource: "config",
        signingSecretSource: "config", // pragma: allowlist secret
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

function makeTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        token: "token-value",
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

async function buildTestTable(
  plugins: ChannelPlugin[],
  params?: { cfg?: Record<string, unknown>; sourceConfig?: Record<string, unknown> },
) {
  vi.mocked(listChannelPlugins).mockReturnValue(plugins);
  return await buildChannelsTable((params?.cfg ?? { channels: {} }) as never, {
    showSecrets: false,
    sourceConfig: params?.sourceConfig as never,
  });
}

function expectTableRow(
  table: TestTable,
  params: { id: string; state: string; detailContains?: string; detailEquals?: string },
) {
  const row = table.rows.find((entry) => entry.id === params.id);
  expect(row).toBeDefined();
  expect(row?.state).toBe(params.state);
  if (params.detailContains) {
    expect(row?.detail).toContain(params.detailContains);
  }
  if (params.detailEquals) {
    expect(row?.detail).toBe(params.detailEquals);
  }
  return row;
}

function expectTableDetailRows(
  table: TestTable,
  title: string,
  rows: Array<Record<string, string>>,
) {
  const detail = table.details.find((entry) => entry.title === title);
  expect(detail).toBeDefined();
  expect(detail?.rows).toEqual(rows);
}

describe("buildChannelsTable - mattermost token summary", () => {
  it("does not require appToken for mattermost accounts", async () => {
    const table = await buildTestTable([makeMattermostPlugin()]);
    const mattermostRow = expectTableRow(table, { id: "mattermost", state: "ok" });
    expect(mattermostRow?.detail).not.toContain("need bot+app");
  });

  it("keeps bot+app requirement when both fields exist", async () => {
    const table = await buildTestTable([makeSlackPlugin({ botToken: "bot-token", appToken: "" })]);
    expectTableRow(table, { id: "slack", state: "warn", detailContains: "need bot+app" });
  });

  it("reports configured-but-unavailable Slack credentials as warn", async () => {
    const table = await buildTestTable([makeUnavailableSlackPlugin()]);
    expectTableRow(table, {
      id: "slack",
      state: "warn",
      detailContains: "unavailable in this command path",
    });
  });

  it("preserves unavailable credential state from the source config snapshot", async () => {
    const table = await buildTestTable([makeSourceAwareUnavailablePlugin()], {
      cfg: { marker: "resolved", channels: {} },
      sourceConfig: { marker: "source", channels: {} },
    });

    expectTableRow(table, {
      id: "slack",
      state: "warn",
      detailContains: "unavailable in this command path",
    });
    expectTableDetailRows(table, "Slack accounts", [
      {
        Account: "primary (Primary)",
        Notes: "bot:config · app:config · secret unavailable in this command path",
        Status: "WARN",
      },
    ]);
  });

  it("treats status-only available credentials as resolved", async () => {
    const table = await buildTestTable([makeSourceUnavailableResolvedAvailablePlugin()], {
      cfg: { marker: "resolved", channels: {} },
      sourceConfig: { marker: "source", channels: {} },
    });

    expectTableRow(table, { id: "discord", state: "ok", detailEquals: "configured" });
    expectTableDetailRows(table, "Discord accounts", [
      {
        Account: "primary (Primary)",
        Notes: "token:config",
        Status: "OK",
      },
    ]);
  });

  it("treats Slack HTTP signing-secret availability as required config", async () => {
    const table = await buildTestTable([makeHttpSlackUnavailablePlugin()]);
    expectTableRow(table, {
      id: "slack",
      state: "warn",
      detailContains: "configured http credentials unavailable",
    });
    expectTableDetailRows(table, "Slack accounts", [
      {
        Account: "primary (Primary)",
        Notes: "bot:config · signing:config · secret unavailable in this command path",
        Status: "WARN",
      },
    ]);
  });

  it("still reports single-token channels as ok", async () => {
    const table = await buildTestTable([makeTokenPlugin()]);
    expectTableRow(table, { id: "token-only", state: "ok", detailContains: "token" });
  });
});
