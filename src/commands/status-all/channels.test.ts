import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountInspectionResult } from "../../channels/account-inspection.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { buildChannelsTable } from "./channels.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  plugins: vi.fn(),
  failures: [] as Array<{ channelId: string; pluginId: string; message: string }>,
  missing: [] as string[],
  external: new Set<string>(),
}));
const plugin = (id: string, accountId = "default", label = id) => ({
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
const unavailable = "configured_unavailable";
const socket = (botToken = "", fields: Record<string, unknown> = {}) => ({
  botToken,
  appToken: "",
  ...fields,
});
const http = (botToken = "", fields: Record<string, unknown> = {}) => ({
  mode: "http",
  botToken,
  signingSecret: "",
  ...fields, // pragma: allowlist secret
});
function inspection(account: Record<string, unknown>, snapshot: ChannelAccountSnapshot) {
  return {
    kind: "inspected",
    account,
    enabled: true,
    configured: true,
    snapshot,
  } satisfies ChannelAccountInspectionResult;
}
function inspect(account: Record<string, unknown>) {
  mocks.inspect.mockResolvedValue(
    inspection(account, {
      accountId: "default",
      enabled: true,
      configured: true,
      ...account,
    }),
  );
}
async function summarize(
  account: Record<string, unknown>,
  snapshot: Partial<ChannelAccountSnapshot> = {},
  showSecrets = false,
) {
  mocks.plugins.mockReturnValue([plugin("mattermost", "primary", "Mattermost")]);
  mocks.inspect.mockResolvedValueOnce(inspection(account, { accountId: "primary", ...snapshot }));
  return (await buildChannelsTable({}, { showSecrets })).rows[0];
}
// mock-isolation: Keep credential inspection synthetic instead of reading configured accounts.
vi.mock("../../channels/account-inspection.js", () => ({
  resolveInspectedChannelAccount: mocks.inspect,
}));
// mock-isolation: Supply the selected channel owners without loading installed plugins.
vi.mock("../../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: (...args: unknown[]) => ({
    plugins: mocks.plugins(...args),
    manifestRecords: [],
    configuredChannelIds: [],
    missingConfiguredChannelIds: [
      ...new Set([...mocks.missing, ...mocks.failures.map(({ channelId }) => channelId)]),
    ],
    loadFailures: mocks.failures,
  }),
}));
// mock-isolation: Control missing-plugin repair hints independently of the installed inventory.
vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) =>
    channelIds
      .filter((id) => mocks.external.has(id))
      .map((channelId) => ({
        channelId,
        label: "Feishu",
        installCommand: "openclaw plugins install @openclaw/feishu",
        doctorFixCommand: "openclaw doctor --fix",
      })),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failures = [];
  mocks.missing = [];
  mocks.external.clear();
  mocks.plugins.mockReturnValue([discordPlugin]);
  inspect({ tokenStatus: unavailable, tokenSource: "secretref" });
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
    expect(table.rows[0]).toMatchObject({
      state: "ok",
      detail: expect.not.stringContaining("unavailable"),
    });
    expect(table.details[0]?.rows[0]).toMatchObject({
      Status: "OK",
      Notes: expect.stringContaining("credential available in gateway runtime"),
    });
  });

  it("warns when an inspector cannot report configuration state", async () => {
    mocks.inspect.mockResolvedValue({
      ...inspection(
        { enabled: true },
        {
          accountId: "default",
          enabled: true,
          stateReason: "configuration status unavailable",
        },
      ),
      configured: undefined,
    });
    const table = await buildChannelsTable(discordConfig);
    expect(table.rows[0]).toMatchObject({
      state: "warn",
      detail: "configuration status unavailable",
    });
    expect(table.details).toEqual([]);
  });

  it("summarizes unavailable credentials without selecting an explicit fleet owner", async () => {
    const table = await buildChannelsTable({
      ...discordConfig,
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });
    expect(table.rows[0]).toMatchObject({
      state: "warn",
      detail: expect.stringContaining("unavailable"),
    });
  });

  it("renders resolved credentials as OK in fast mode without live status", async () => {
    inspect({
      token: "8905123456:AAF-example-bDTs",
      tokenSource: "config",
      tokenStatus: "available",
    });
    const table = await buildChannelsTable(discordConfig, {
      includeSetupFallbackPlugins: false,
      liveChannelStatus: null,
    });
    expect(table.rows[0]).toMatchObject({
      state: "ok",
      detail: expect.stringContaining("token config"),
    });
    expect(table.details[0]?.rows[0]?.Status).toBe("OK");
  });

  it("formats human phone identity while preserving raw account ids", async () => {
    const signal = plugin("signal", "work", "Signal");
    mocks.plugins.mockReturnValue([
      {
        ...signal,
        config: {
          ...signal.config,
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
      },
    ]);
    const account = { name: "+12133734253", allowFrom: ["+442079460018", "bot-token"] };
    mocks.inspect.mockResolvedValue({
      ...inspection(account, { accountId: "work", enabled: true, configured: true, ...account }),
      kind: "resolved",
    });
    const table = await buildChannelsTable({ channels: { signal: { enabled: true } } });
    expect(table.rows[0]?.detail).toBe("linked · +1 555 123 4567 (id: +15551234567)");
    expect(table.details[0]?.rows[0]).toEqual({
      Account: "work (+12133734253)",
      Status: "OK",
      Notes: "allow:+44 20 7946 0018 (id: 442079460018),bot-token",
    });
  });

  it.each`
    kind         | id            | label         | detail
    ${"missing"} | ${"feishu"}   | ${"Feishu"}   | ${"plugin not installed - run openclaw plugins install @openclaw/feishu or openclaw doctor --fix"}
    ${"failed"}  | ${"telegram"} | ${"telegram"} | ${"plugin load failed: dependency tree corrupted; run openclaw doctor --fix"}
    ${"blocked"} | ${"feishu"}   | ${"Feishu"}   | ${null}
  `(
    "reports $kind channel plugins without inspecting accounts",
    async ({ kind, id, label, detail }) => {
      mocks.plugins.mockReturnValue([]);
      if (kind === "missing") {
        mocks.external.add(id);
      }
      if (kind === "failed") {
        mocks.failures = [
          { channelId: id, pluginId: id, message: 'Cannot find module "ansi-escapes"' },
        ];
      }
      const table = await buildChannelsTable({ channels: { [id]: { enabled: true } } });
      expect(table).toStrictEqual({
        rows: detail === null ? [] : [{ id, label, enabled: true, state: "warn", detail }],
        details: [],
      });
      expect(mocks.inspect).not.toHaveBeenCalled();
    },
  );

  it("keeps configured channels visible and ordered when fast mode skips setup plugins", async () => {
    mocks.plugins.mockReturnValue([]);
    mocks.missing = ["zulu", "telegram", "alpha"];
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
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("sanitizes fast-path configured-channel labels", async () => {
    mocks.plugins.mockReturnValue([]);
    const osc = (value: string) => "\u001b]0;" + value + "\u0007";
    const unsafeChannel = osc("owned") + "telegram";
    const table = await buildChannelsTable(
      {
        channels: {
          [unsafeChannel]: { botToken: "123:abc" },
          [osc("only-control")]: { botToken: "123:abc" },
        },
      },
      { includeSetupFallbackPlugins: false },
    );
    expect(table.rows.find((row) => row.id === unsafeChannel)?.label).toBe("telegram");
    expect(table.rows.find((row) => row.label === "configured-channel")).toBeDefined();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});

describe("channel table credential summaries", () => {
  it("does not require appToken for bot-token-only channels", async () => {
    expect(
      await summarize(
        { botToken: "bot-token-value", baseUrl: "https://mm.example.com" },
        { botTokenSource: "config" },
      ),
    ).toMatchObject({
      state: "ok",
      detail: expect.stringMatching(
        /^bot token config \(sha256:[a-f0-9]{8} · len 15\) · accounts 1\/1$/u,
      ),
    });
  });

  it.each`
    account                                                                        | snapshot                                                       | state      | detail
    ${socket("bot-token")}                                                         | ${{}}                                                          | ${"warn"}  | ${expect.stringContaining("need bot+app")}
    ${socket("", { botTokenStatus: unavailable, appTokenStatus: unavailable })}    | ${{ botTokenSource: "config", appTokenSource: "config" }}      | ${"warn"}  | ${expect.stringContaining("unavailable in this command path")}
    ${http("", { botTokenStatus: "available", signingSecretStatus: "available" })} | ${{ botTokenSource: "config", signingSecretSource: "config" }} | ${"ok"}    | ${expect.stringContaining("credentials ok")}
    ${http("bot-token", { signingSecretStatus: unavailable })}                     | ${{}}                                                          | ${"warn"}  | ${"configured http credentials unavailable in this command path · accounts 1"}
    ${socket("bot-token", { mode: "socket", appTokenStatus: unavailable })}        | ${{}}                                                          | ${"warn"}  | ${"configured credentials unavailable in this command path · accounts 1"}
    ${socket("", { botTokenStatus: "available", appTokenStatus: "available" })}    | ${{}}                                                          | ${"setup"} | ${"no tokens (need bot+app)"}
  `("reports $state for $account", async ({ account, snapshot, state, detail }) => {
    expect(await summarize(account, snapshot)).toMatchObject({ state, detail });
  });

  it.each([
    ["sk-1234567890", "sk-1…7890 · len 13"],
    ["abc😀" + "x".repeat(10), "abc…xxxx · len 15"],
    ["x".repeat(10) + "😀abc", "xxxx…abc · len 15"],
    ["a😀b", "a😀b · len 4"],
  ])("formats a visible token hint without splitting %p", async (token, expectedHint) => {
    expect((await summarize({ token }, { tokenSource: "config" }, true))?.detail).toContain(
      "token config (" + expectedHint + ")",
    );
  });
});
