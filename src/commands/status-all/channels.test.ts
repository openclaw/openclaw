import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountInspectionResult } from "../../channels/account-inspection.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { buildChannelsTable } from "./channels.js";

const mocks = vi.hoisted(() => ({
  resolveInspectedChannelAccount: vi.fn(),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  readOnlyChannelLoadFailures: [] as Array<{
    channelId: string;
    pluginId: string;
    message: string;
  }>,
  missingConfiguredChannelIds: [] as string[],
  missingOfficialExternalChannels: new Set<string>(),
}));

const channelPlugin = (id: string, label: string, accountId = "default") => ({
  id,
  meta: { label },
  config: { listAccountIds: () => [accountId], defaultAccountId: () => accountId },
});
const discordPlugin = {
  id: "discord",
  meta: { label: "Discord" },
  config: { listAccountIds: () => ["default"] },
};

const discordConfig = { channels: { discord: { enabled: true } } };
function inspectAccount(
  account: Record<string, unknown>,
  { kind = "inspected", accountId = "default" } = {},
) {
  mocks.resolveInspectedChannelAccount.mockResolvedValue({
    kind,
    account,
    enabled: true,
    configured: true,
    snapshot: { accountId, enabled: true, configured: true, ...account },
  });
}

function expectUnavailablePlugin(
  table: Awaited<ReturnType<typeof buildChannelsTable>>,
  id: string,
  label: string,
  detail: string,
) {
  expect(table).toStrictEqual({
    rows: [{ id, label, enabled: true, state: "warn", detail }],
    details: [],
  });
  expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
}

vi.mock("../../channels/account-inspection.js", () => ({
  resolveInspectedChannelAccount: mocks.resolveInspectedChannelAccount,
}));

vi.mock("../../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: (...args: unknown[]) => ({
    plugins: mocks.listReadOnlyChannelPluginsForConfig(...args),
    manifestRecords: [],
    configuredChannelIds: [],
    missingConfiguredChannelIds: [
      ...new Set([
        ...mocks.missingConfiguredChannelIds,
        ...mocks.readOnlyChannelLoadFailures.map((failure) => failure.channelId),
      ]),
    ],
    loadFailures: mocks.readOnlyChannelLoadFailures,
  }),
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) =>
    channelIds.flatMap((channelId) =>
      mocks.missingOfficialExternalChannels.has(channelId)
        ? [
            {
              pluginId: channelId,
              channelId,
              label: "Feishu",
              installSpec: "@openclaw/feishu",
              installCommand: "openclaw plugins install @openclaw/feishu",
              doctorFixCommand: "openclaw doctor --fix",
              repairHint:
                "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
            },
          ]
        : [],
    ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readOnlyChannelLoadFailures = [];
  mocks.missingConfiguredChannelIds = [];
  mocks.missingOfficialExternalChannels.clear();
  mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([discordPlugin]);
  inspectAccount({ tokenStatus: "configured_unavailable", tokenSource: "secretref" });
});

describe("buildChannelsTable", () => {
  it("keeps a live gateway-backed account OK when local status cannot resolve the token", async () => {
    const table = await buildChannelsTable(discordConfig, {
      liveChannelStatus: {
        channelAccounts: {
          discord: [
            {
              accountId: "default",
              running: true,
              connected: true,
              tokenStatus: "available",
            },
          ],
        },
      },
    });

    const row = table.rows.find((entry) => entry.id === "discord");
    expect(row?.state).toBe("ok");
    expect(row?.detail).not.toContain("unavailable");
    const detailRow = table.details[0]?.rows[0];
    expect(detailRow?.Status).toBe("OK");
    expect(detailRow?.Notes).toContain("credential available in gateway runtime");
  });

  it("warns when an inspector cannot report configuration state", async () => {
    mocks.resolveInspectedChannelAccount.mockResolvedValue({
      kind: "inspected",
      account: { enabled: true },
      enabled: true,
      configured: undefined,
      snapshot: {
        accountId: "default",
        enabled: true,
        stateReason: "configuration status unavailable",
      },
    });

    const table = await buildChannelsTable(discordConfig);
    expect(table.rows).toEqual([
      {
        id: "discord",
        label: "Discord",
        enabled: true,
        state: "warn",
        detail: "configuration status unavailable",
      },
    ]);
    expect(table.details).toEqual([]);
  });

  it("summarizes channels without selecting an owner from an explicit multi-agent roster", async () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { ops: {}, research: {} },
      },
      channels: { discord: { enabled: true } },
    };

    const table = await buildChannelsTable(config);

    expect(table.rows).toContainEqual(
      expect.objectContaining({
        id: "discord",
        state: "warn",
        detail: expect.stringContaining("unavailable"),
      }),
    );
    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(config, {
      activationSourceConfig: config,
      includeSetupFallbackPlugins: true,
    });
  });

  it("renders a resolved credential as OK on fast-path scans without live channel status", async () => {
    inspectAccount({
      token: "8905123456:AAF-example-bDTs",
      tokenSource: "config",
      tokenStatus: "available",
    });

    const table = await buildChannelsTable(discordConfig, {
      includeSetupFallbackPlugins: false,
      liveChannelStatus: null,
    });

    const row = table.rows.find((entry) => entry.id === "discord");
    expect(row?.state).toBe("ok");
    expect(row?.detail).toContain("token config");
    const detailRow = table.details[0]?.rows[0];
    expect(detailRow?.Status).toBe("OK");
  });

  it("formats human phone identity while preserving raw account ids", async () => {
    const phonePlugin = {
      ...channelPlugin("signal", "Signal", "work"),
      config: {
        ...channelPlugin("signal", "Signal", "work").config,
        formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
          allowFrom.map((entry) => String(entry).replace(/^\+/u, "")),
      },
      configSchema: {
        schema: { type: "object" },
        uiHints: { allowFrom: { presentation: "phone-number" } },
      },
      status: {
        buildChannelSummary: async () => ({
          statusState: "linked",
          self: { e164: "+15551234567" },
        }),
      },
    };
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([phonePlugin]);
    inspectAccount(
      {
        name: "+12133734253",
        allowFrom: ["+442079460018", "bot-token"],
      },
      { kind: "resolved", accountId: "work" },
    );

    const table = await buildChannelsTable({ channels: { signal: { enabled: true } } });

    expect(table.rows).toContainEqual(
      expect.objectContaining({
        id: "signal",
        detail: "linked · +1 555 123 4567 (id: +15551234567)",
      }),
    );
    expect(table.details[0]?.rows[0]).toEqual({
      Account: "work (+12133734253)",
      Status: "OK",
      Notes: "allow:+44 20 7946 0018 (id: 442079460018),bot-token",
    });
  });

  it("shows configured official external channels when the plugin is missing", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.missingOfficialExternalChannels.add("feishu");

    const table = await buildChannelsTable({ channels: { feishu: { appId: "cli_xxx" } } });

    expectUnavailablePlugin(
      table,
      "feishu",
      "Feishu",
      "plugin not installed - run openclaw plugins install @openclaw/feishu or openclaw doctor --fix",
    );
  });

  it("shows plugin load failures for configured channels whose setup registration fails", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.readOnlyChannelLoadFailures = [
      {
        channelId: "telegram",
        pluginId: "telegram",
        message: 'failed to load setup entry: Cannot find module "ansi-escapes"',
      },
    ];

    const table = await buildChannelsTable({ channels: { telegram: { botToken: "123:abc" } } });

    expectUnavailablePlugin(
      table,
      "telegram",
      "telegram",
      "plugin load failed: dependency tree corrupted; run openclaw doctor --fix",
    );
  });

  it("does not show install repair rows when an external channel owner is policy-blocked", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);

    const table = await buildChannelsTable({ channels: { feishu: { appId: "cli_xxx" } } });

    expect(table.rows).toStrictEqual([]);
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });

  it("keeps configured channels visible when fast status skips setup fallback plugins", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.missingConfiguredChannelIds = ["zulu", "telegram", "alpha"];

    const table = await buildChannelsTable(
      {
        channels: {
          telegram: { enabled: true },
          shared: { enabled: true },
          disabled: { enabled: false },
        },
      },
      {
        includeSetupFallbackPlugins: false,
        sourceConfig: { channels: { beta: { enabled: true }, shared: { enabled: true } } },
      },
    );

    expect(table.rows).toStrictEqual(
      ["beta", "shared", "telegram", "alpha", "zulu"].map((id) => ({
        id,
        label: id,
        enabled: true,
        state: "setup",
        detail: "configured; status unavailable in fast mode",
      })),
    );
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });

  it("sanitizes fast-path configured-channel labels", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    const osc = (value: string) =>
      `${String.fromCharCode(0x1b)}]0;${value}${String.fromCharCode(0x07)}`;
    const unsafeChannel = `${osc("owned")}telegram`;

    const table = await buildChannelsTable(
      {
        channels: {
          [unsafeChannel]: { botToken: "123:abc" },
          [osc("only-control")]: { botToken: "123:abc" },
        },
      },
      { includeSetupFallbackPlugins: false },
    );

    expect(table.rows.find((row) => row.id === unsafeChannel)).toMatchObject({
      id: unsafeChannel,
      label: "telegram",
    });
    expect(table.rows.find((row) => row.label === "configured-channel")).toBeDefined();
    expect(mocks.resolveInspectedChannelAccount).not.toHaveBeenCalled();
  });
});

async function summarize(
  account: Record<string, unknown>,
  snapshot: Partial<ChannelAccountSnapshot> = {},
  showSecrets = false,
) {
  mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
    channelPlugin("mattermost", "Mattermost", "primary"),
  ]);
  mocks.resolveInspectedChannelAccount.mockResolvedValueOnce({
    kind: "inspected",
    account,
    enabled: true,
    configured: true,
    snapshot: { accountId: "primary", ...snapshot },
  } satisfies ChannelAccountInspectionResult);
  const table = await buildChannelsTable({}, { showSecrets });
  const row = table.rows[0];
  if (!row) {
    throw new Error("channel row missing");
  }
  return row;
}

describe("channel table credential summaries", () => {
  it("does not require appToken for bot-token-only channels", async () => {
    const summary = await summarize(
      { botToken: "bot-token-value", baseUrl: "https://mm.example.com" },
      { botTokenSource: "config" },
    );

    expect(summary).toMatchObject({
      state: "ok",
      detail: expect.stringMatching(
        /^bot token config \(sha256:[a-f0-9]{8} · len 15\) · accounts 1\/1$/u,
      ),
    });
  });

  it.each([
    {
      name: "requires both bot and app tokens",
      account: { botToken: "bot-token", appToken: "" },
      snapshot: {},
      expected: { state: "warn", detail: expect.stringContaining("need bot+app") },
    },
    {
      name: "warns for configured-but-unavailable credentials",
      account: {
        botToken: "",
        appToken: "",
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "configured_unavailable",
      },
      snapshot: { botTokenSource: "config", appTokenSource: "config" },
      expected: {
        state: "warn",
        detail: expect.stringContaining("unavailable in this command path"),
      },
    },
    {
      name: "accepts status-only available HTTP credentials",
      account: {
        mode: "http",
        botToken: "",
        signingSecret: "", // pragma: allowlist secret
        botTokenStatus: "available",
        signingSecretStatus: "available", // pragma: allowlist secret
      },
      snapshot: { botTokenSource: "config", signingSecretSource: "config" }, // pragma: allowlist secret
      expected: { state: "ok", detail: expect.stringContaining("credentials ok") },
    },
    {
      name: "prioritizes unavailable credentials in HTTP mode",
      account: {
        mode: "http",
        botToken: "bot-token",
        signingSecret: "", // pragma: allowlist secret
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      },
      snapshot: {},
      expected: {
        state: "warn",
        detail: "configured http credentials unavailable in this command path · accounts 1",
      },
    },
    {
      name: "preserves public unavailable-credential precedence in socket mode",
      account: {
        mode: "socket",
        botToken: "bot-token",
        appToken: "",
        appTokenStatus: "configured_unavailable",
      },
      snapshot: {},
      expected: {
        state: "warn",
        detail: "configured credentials unavailable in this command path · accounts 1",
      },
    },
    {
      name: "requires socket token values despite available status fields",
      account: {
        botToken: "",
        appToken: "",
        botTokenStatus: "available",
        appTokenStatus: "available",
      },
      snapshot: {},
      expected: { state: "setup", detail: "no tokens (need bot+app)" },
    },
  ])("$name", async ({ account, snapshot, expected }) => {
    expect(await summarize(account, snapshot)).toMatchObject(expected);
  });

  it.each([
    ["sk-1234567890", "sk-1…7890 · len 13"],
    [`abc😀${"x".repeat(10)}`, "abc…xxxx · len 15"],
    [`${"x".repeat(10)}😀abc`, "xxxx…abc · len 15"],
    ["a😀b", "a😀b · len 4"],
  ])("formats a visible token hint without splitting %p", async (token, expectedHint) => {
    const summary = await summarize({ token }, { tokenSource: "config" }, true);

    expect(summary.detail).toContain(`token config (${expectedHint})`);
  });
});
