// Mattermost token summary tests cover status-all credential source counting and safe display output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAccountInspectionResult } from "../../channels/account-inspection.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { buildChannelsTable } from "./channels.js";

const mocks = vi.hoisted(() => ({ resolveInspectedChannelAccount: vi.fn() }));
vi.mock("../../channels/account-inspection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/account-inspection.js")>()),
  resolveInspectedChannelAccount: mocks.resolveInspectedChannelAccount,
}));
vi.mock("../../channels/plugins/read-only.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/read-only.js")>()),
  resolveReadOnlyChannelPluginsForConfig: () => ({
    plugins: [
      {
        id: "mattermost",
        meta: { label: "Mattermost" },
        config: {
          listAccountIds: () => ["primary"],
          defaultAccountId: () => "primary",
        },
      },
    ],
    manifestRecords: [],
    missingConfiguredChannelIds: [],
    loadFailures: [],
  }),
}));

beforeEach(() => vi.clearAllMocks());

function tokenRow(params: {
  account: Record<string, unknown>;
  snapshot?: Partial<ChannelAccountSnapshot>;
  enabled?: boolean;
}): ChannelAccountInspectionResult {
  return {
    kind: "inspected",
    account: params.account,
    enabled: params.enabled ?? true,
    configured: true,
    snapshot: {
      accountId: "primary",
      ...params.snapshot,
    },
  };
}

async function summarize(accounts: ChannelAccountInspectionResult[], showSecrets = false) {
  for (const account of accounts) {
    mocks.resolveInspectedChannelAccount.mockResolvedValueOnce(account);
  }
  const table = await buildChannelsTable({}, { showSecrets });
  const row = table.rows[0];
  if (!row) {
    throw new Error("channel row missing");
  }
  return row;
}

describe("channel table credential summaries", () => {
  it("does not require appToken for bot-token-only channels", async () => {
    const summary = await summarize([
      tokenRow({
        account: {
          botToken: "bot-token-value",
          baseUrl: "https://mm.example.com",
        },
        snapshot: { botTokenSource: "config" },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("bot token config");
    expect(summary.detail).not.toContain("need bot+app");
    expect(summary.detail).toMatch(/sha256:[a-f0-9]{8} · len 15/u);
    expect(summary.detail).not.toContain("bot-token-value");
  });

  it("keeps bot+app requirement when both fields exist", async () => {
    const summary = await summarize([
      tokenRow({
        account: {
          botToken: "bot-token",
          appToken: "",
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("need bot+app");
  });

  it("reports configured-but-unavailable Slack credentials as warn", async () => {
    const summary = await summarize([
      tokenRow({
        account: {
          configured: true,
          botToken: "",
          appToken: "",
          botTokenSource: "config",
          appTokenSource: "config",
          botTokenStatus: "configured_unavailable",
          appTokenStatus: "configured_unavailable",
        },
        snapshot: {
          botTokenSource: "config",
          appTokenSource: "config",
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("unavailable in this command path");
  });

  it("treats status-only available HTTP credentials as resolved", async () => {
    const summary = await summarize([
      tokenRow({
        account: {
          mode: "http",
          botToken: "",
          signingSecret: "", // pragma: allowlist secret
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
          botTokenStatus: "available",
          signingSecretStatus: "available", // pragma: allowlist secret
        },
        snapshot: {
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
        },
      }),
    ]);

    expect(summary.state).toBe("ok");
    expect(summary.detail).toContain("credentials ok");
  });

  it("treats Slack HTTP signing-secret availability as required config", async () => {
    const summary = await summarize([
      tokenRow({
        account: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "", // pragma: allowlist secret
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
          botTokenStatus: "available",
          signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        },
        snapshot: {
          botTokenSource: "config",
          signingSecretSource: "config", // pragma: allowlist secret
        },
      }),
    ]);

    expect(summary.state).toBe("warn");
    expect(summary.detail).toContain("configured http credentials unavailable");
  });

  it.each([
    {
      mode: "http",
      account: {
        botToken: "bot-token",
        signingSecret: "", // pragma: allowlist secret
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      },
      detail: "configured http credentials unavailable in this command path · accounts 1",
    },
    {
      mode: "socket",
      account: {
        botToken: "bot-token",
        appToken: "",
        appTokenStatus: "configured_unavailable",
      },
      detail: "configured credentials unavailable in this command path · accounts 1",
    },
  ])(
    "preserves public unavailable-credential precedence in $mode mode",
    async ({ mode, account, detail }) => {
      expect(await summarize([tokenRow({ account: { mode, ...account } })])).toMatchObject({
        state: "warn",
        detail,
      });
    },
  );

  it("requires token values for socket mode even when status fields report available", async () => {
    expect(
      await summarize([
        tokenRow({
          account: {
            botToken: "",
            appToken: "",
            botTokenStatus: "available",
            appTokenStatus: "available",
          },
        }),
      ]),
    ).toMatchObject({ state: "setup", detail: "no tokens (need bot+app)" });
  });

  it.each([
    ["sk-1234567890", "sk-1…7890 · len 13"],
    [`abc😀${"x".repeat(10)}`, "abc…xxxx · len 15"],
    [`${"x".repeat(10)}😀abc`, "xxxx…abc · len 15"],
    ["a😀b", "a😀b · len 4"],
  ])("formats a visible token hint without splitting %p", async (token, expectedHint) => {
    const summary = await summarize(
      [tokenRow({ account: { token }, snapshot: { tokenSource: "config" } })],
      true,
    );

    expect(summary.detail).toContain(`token config (${expectedHint})`);
  });
});
