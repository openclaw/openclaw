import { expect, it, vi } from "vitest";
import { listReadOnlyChannelPluginsForConfigAsync } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { buildChannelSummary } from "./channel-summary.js";

vi.mock("../channels/plugins/read-only.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/read-only.js")>()),
  listReadOnlyChannelPluginsForConfigAsync: vi.fn(),
}));

type FixtureAccount = Record<string, unknown> & { configured?: boolean; enabled?: boolean };
const sourceConfig = { marker: "source", channels: {} };
const summaryFor = (plugin: ChannelPlugin, options?: Parameters<typeof buildChannelSummary>[1]) => {
  vi.mocked(listReadOnlyChannelPluginsForConfigAsync).mockResolvedValueOnce([plugin]);
  return buildChannelSummary({ channels: {} }, options);
};
function makePlugin(
  label: string,
  account: FixtureAccount,
  options: {
    id?: string;
    accountIds?: string[];
    defaultAccountId?: string;
    sourceAccount?: FixtureAccount;
  } = {},
): ChannelPlugin {
  const id = options.id ?? label.toLowerCase();
  const getAccount = (_cfg: unknown, accountId?: string | null) => ({
    accountId,
    enabled: true,
    configured: true,
    ...account,
  });
  return createChannelTestPluginBase({
    id,
    label,
    config: {
      listAccountIds: () => options.accountIds ?? ["primary"],
      defaultAccountId: () => options.defaultAccountId ?? "primary",
      resolveAccount: getAccount,
      inspectAccount: (cfg, accountId) => ({
        ...getAccount(cfg, accountId),
        ...((cfg as { marker?: string }).marker === "source" ? options.sourceAccount : {}),
      }),
      isConfigured: (value) => Boolean((value as FixtureAccount).configured),
      isEnabled: (value) => Boolean((value as FixtureAccount).enabled),
      formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
    },
  });
}

type LinkedSummary = {
  linked?: boolean;
  statusState?: string;
  authAgeMs?: number;
  allowFrom?: string[];
};

it("preserves Slack HTTP signing-secret unavailable state from source config", async () => {
  const plugin = makePlugin(
    "Slack",
    {
      name: "Primary",
      configured: false,
      mode: "http",
      botToken: "xoxb-http",
      botTokenSource: "config",
      botTokenStatus: "available",
    },
    {
      sourceAccount: {
        configured: true,
        signingSecret: "",
        signingSecretSource: "config", // pragma: allowlist secret
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      },
    },
  );
  const lines = await summaryFor(plugin, { sourceConfig });
  expect(lines).toEqual(
    expect.arrayContaining([
      "Slack: configured",
      "  - primary (Primary) (bot:config, signing:config, secret unavailable in this command path)",
    ]),
  );
});

it.each<[LinkedSummary, boolean, string[]]>([
  [
    { linked: true, authAgeMs: 300_000, allowFrom: ["+12133734253", "bot-token", "ignored"] },
    true,
    [
      "Telegram: linked +15551234567 auth 5m ago",
      "  - primary (Main Bot) (dm:mutuals, token:env, allow:+12133734253,bot-token)",
    ],
  ],
  [{ linked: false }, false, ["Telegram: not linked +15551234567"]],
  [{ statusState: "unstable" }, false, ["Telegram: auth stabilizing +15551234567"]],
])("renders linked status %j (allowFrom=%s)", async (params, includeAllowFrom, expected) => {
  const plugin = makePlugin(
    "Telegram",
    {
      name: "Main Bot",
      linked: params.linked,
      allowFrom: params.allowFrom ?? [],
      dmPolicy: "mutuals",
      tokenSource: "env",
    },
    { id: "linked-summary-fixture" },
  );
  plugin.config.inspectAccount = undefined;
  plugin.status = {
    buildChannelSummary: async () => ({
      ...params,
      configured: true,
      self: { e164: "+15551234567" },
    }),
  };
  const lines = await summaryFor(plugin, { includeAllowFrom });
  expect(lines).toEqual(expect.arrayContaining(expected));
});

it("renders non-slack account detail fields for configured accounts", async () => {
  const plugin = makePlugin(
    "Signal",
    {
      name: "Desktop",
      enabled: false,
      appTokenSource: "env",
      baseUrl: "https://signal.example.test",
      port: 31337,
      cliPath: "/usr/local/bin/signal-cli",
      dbPath: "/tmp/signal.db",
    },
    { accountIds: ["desktop"], defaultAccountId: "desktop" },
  );
  await expect(summaryFor(plugin)).resolves.toEqual([
    "Signal: disabled",
    "  - desktop (Desktop) (disabled, app:env, https://signal.example.test, port:31337, cli:/usr/local/bin/signal-cli, db:/tmp/signal.db)",
  ]);
});

it.each([
  [undefined, [], "default", ["Fallback: configuration status unavailable"]],
  [true, [], "fallback-account", ["Fallback: configured", "  - fallback-account"]],
  [false, ["fallback-account"], "default", ["Fallback: not configured"]],
] as const)(
  "renders fallback configuration %s",
  async (configured, accountIds, defaultAccountId, expected) => {
    const unknown = configured === undefined;
    const plugin = makePlugin(
      "Fallback",
      { configured: configured ?? true },
      {
        id: "fallback-plugin",
        accountIds: [...accountIds],
        defaultAccountId,
      },
    );
    if (unknown) {
      plugin.config.inspectAccount = () => ({ accountId: "default", enabled: true });
    }
    vi.mocked(listReadOnlyChannelPluginsForConfigAsync).mockResolvedValueOnce([plugin]);
    await expect(buildChannelSummary(unknown ? {} : { channels: {} })).resolves.toEqual(expected);
  },
);
