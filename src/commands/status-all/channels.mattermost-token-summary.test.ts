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

async function summarize(
  account: Record<string, unknown>,
  snapshot: Partial<ChannelAccountSnapshot> = {},
  showSecrets = false,
) {
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
