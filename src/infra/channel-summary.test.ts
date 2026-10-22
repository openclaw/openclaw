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
function makePlugin(
  label: string,
  account: FixtureAccount,
  options: {
    id?: string;
    accountIds?: string[];
    defaultAccountId?: string;
    inspect?: boolean;
    sourceAccount?: FixtureAccount;
    summary?: Record<string, unknown>;
  } = {},
): ChannelPlugin {
  const id = options.id ?? label.toLowerCase();
  const summary = options.summary;
  const getAccount = (_cfg: unknown, accountId?: string | null) => ({
    accountId,
    enabled: true,
    configured: true,
    ...account,
  });
  return {
    ...createChannelTestPluginBase({
      id,
      label,
      config: {
        listAccountIds: () => options.accountIds ?? ["primary"],
        defaultAccountId: () => options.defaultAccountId ?? "primary",
        resolveAccount: getAccount,
        inspectAccount:
          options.inspect === false
            ? undefined
            : (cfg, accountId) => ({
                ...getAccount(cfg, accountId),
                ...((cfg as { marker?: string }).marker === "source" ? options.sourceAccount : {}),
              }),
        isConfigured: (value) => Boolean((value as FixtureAccount).configured),
        isEnabled: (value) => Boolean((value as FixtureAccount).enabled),
        formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
      },
    }),
    status: summary ? { buildChannelSummary: async () => summary } : undefined,
  };
}

function linkedPlugin({
  allowFrom = [],
  ...summary
}: {
  linked?: boolean;
  statusState?: string;
  authAgeMs?: number;
  allowFrom?: string[];
}) {
  return makePlugin(
    "Telegram",
    {
      name: "Main Bot",
      linked: summary.linked,
      allowFrom,
      dmPolicy: "mutuals",
      tokenSource: "env",
    },
    {
      id: "linked-summary-fixture",
      inspect: false,
      summary: { ...summary, configured: true, self: { e164: "+15551234567" } },
    },
  );
}

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
  vi.mocked(listReadOnlyChannelPluginsForConfigAsync).mockResolvedValueOnce([plugin]);
  const lines = await buildChannelSummary({ marker: "resolved", channels: {} } as never, {
    sourceConfig: { marker: "source", channels: {} } as never,
  });
  expect(lines).toEqual(
    expect.arrayContaining([
      "Slack: configured",
      "  - primary (Primary) (bot:config, signing:config, secret unavailable in this command path)",
    ]),
  );
});

it.each<[string, Parameters<typeof linkedPlugin>[0], boolean, string[]]>([
  [
    "includes linked metadata and truncates allow-from details",
    { linked: true, authAgeMs: 300_000, allowFrom: ["+12133734253", "bot-token", "ignored"] },
    true,
    [
      "Telegram: linked +15551234567 auth 5m ago",
      "  - primary (Main Bot) (dm:mutuals, token:env, allow:+12133734253,bot-token)",
    ],
  ],
  [
    "shows not-linked status when linked metadata is explicitly false",
    { linked: false },
    false,
    ["Telegram: not linked +15551234567", "  - primary (Main Bot) (dm:mutuals, token:env)"],
  ],
  [
    "prefers plugin statusState when provided",
    { statusState: "unstable" },
    false,
    ["Telegram: auth stabilizing +15551234567"],
  ],
])("%s", async (_name, params, includeAllowFrom, expected) => {
  vi.mocked(listReadOnlyChannelPluginsForConfigAsync).mockResolvedValueOnce([linkedPlugin(params)]);
  const lines = await buildChannelSummary({ channels: {} }, { includeAllowFrom });
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
  vi.mocked(listReadOnlyChannelPluginsForConfigAsync).mockResolvedValueOnce([plugin]);
  await expect(buildChannelSummary({ channels: {} })).resolves.toEqual([
    "Signal: disabled",
    "  - desktop (Desktop) (disabled, app:env, https://signal.example.test, port:31337, cli:/usr/local/bin/signal-cli, db:/tmp/signal.db)",
  ]);
});

it.each([
  {
    name: "reports omitted inspector configuration as unknown",
    params: { configured: true },
    unknown: true,
    expected: ["Fallback: configuration status unavailable"],
  },
  {
    name: "uses the channel label and default account id when no accounts exist",
    params: { configured: true, accountIds: [], defaultAccountId: "fallback-account" },
    unknown: false,
    expected: ["Fallback: configured", "  - fallback-account"],
  },
  {
    name: "shows not-configured status when enabled accounts exist without configured ones",
    params: { configured: false, accountIds: ["fallback-account"] },
    unknown: false,
    expected: ["Fallback: not configured"],
  },
])("$name", async ({ params, unknown, expected }) => {
  const plugin = makePlugin(
    "Fallback",
    { configured: params.configured },
    {
      id: "fallback-plugin",
      accountIds: params.accountIds ?? [],
      defaultAccountId: params.defaultAccountId ?? "default",
    },
  );
  if (unknown) {
    plugin.config.inspectAccount = () => ({ accountId: "default", enabled: true });
  }
  vi.mocked(listReadOnlyChannelPluginsForConfigAsync).mockResolvedValueOnce([plugin]);
  await expect(buildChannelSummary(unknown ? {} : { channels: {} })).resolves.toEqual(expected);
});
