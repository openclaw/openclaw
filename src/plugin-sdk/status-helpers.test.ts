import { describe, expect, it } from "vitest";
import { evaluateChannelHealth } from "../gateway/channel-health-policy.js";
import {
  createAsyncComputedAccountStatusAdapter,
  buildComputedAccountStatusSnapshot,
  buildRuntimeAccountStatusSnapshot,
  createComputedAccountStatusAdapter,
  buildWebhookChannelStatusSummary,
  buildTokenChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDependentCredentialStatusIssueCollector,
  createDefaultChannelRuntimeState,
  readAccountStatusSnapshot,
  standardDmPolicyOpenIssue,
  standardNotConfiguredIssue,
} from "./status-helpers.js";

describe("status issue composition", () => {
  it("coerces only standard and requested account fields", () => {
    const fields = { accountId: "work", enabled: true, configured: true, mode: "polling" };
    expect(readAccountStatusSnapshot({ ...fields, secret: "drop" }, ["mode"])).toEqual({
      ...fields,
      running: undefined,
      connected: undefined,
    });
    expect(readAccountStatusSnapshot(null, ["mode"])).toBeNull();
  });

  it("builds standard open-policy and missing-auth issues", () => {
    const account = { channel: "zalo", accountId: "default" };
    expect(
      standardDmPolicyOpenIssue({ ...account, channelLabel: "Zalo", configPath: "channels.zalo" }),
    ).toEqual({
      ...account,
      kind: "config",
      message: 'Zalo dmPolicy is "open", allowing any user to message the bot without pairing.',
      fix: 'Set channels.zalo.dmPolicy to "pairing" or "allowlist" to restrict access.',
    });
    const auth = {
      ...account,
      channel: "zalouser",
      message: "Not authenticated.",
      fix: "Run login.",
    };
    expect(standardNotConfiguredIssue({ ...auth })).toEqual({ ...auth, kind: "auth" });
  });
});

const defaultRuntimeState = {
  running: false,
  lastStartAt: null,
  lastStopAt: null,
  lastError: null,
};

const defaultAccountSnapshot = {
  accountId: "default",
  name: undefined,
  enabled: undefined,
  configured: false,
  ...defaultRuntimeState,
  probe: undefined,
  lastInboundAt: null,
  lastOutboundAt: null,
};

const adapterAccount = { accountId: "default", enabled: true, profileUrl: "https://example.test" };
const adapterProbe = { ok: true };
function accountSnapshot(mode: "sync" | "async", ingressUnavailable?: true) {
  const resolveAccountSnapshot = ({
    account,
    runtime,
    probe,
  }: {
    account: typeof adapterAccount;
    runtime?: { running?: boolean };
    probe?: typeof adapterProbe;
  }) => ({
    accountId: account.accountId,
    enabled: account.enabled,
    configured: true,
    extra: { profileUrl: account.profileUrl, connected: runtime?.running ?? false, probe },
  });
  const options = {
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot,
  };
  const adapter =
    mode === "async"
      ? createAsyncComputedAccountStatusAdapter({
          ...options,
          resolveAccountSnapshot: async (params: Parameters<typeof resolveAccountSnapshot>[0]) =>
            resolveAccountSnapshot(params),
        })
      : createComputedAccountStatusAdapter(options);
  return adapter.buildAccountSnapshot!({
    account: adapterAccount,
    cfg: {} as never,
    runtime: {
      accountId: "default",
      running: true,
      ...(ingressUnavailable ? { ingressUnavailable } : {}),
    },
    probe: adapterProbe,
  });
}

it("builds account status when configured is computed outside resolver", () => {
  expect(
    buildComputedAccountStatusSnapshot({ accountId: "default", enabled: true, configured: false }),
  ).toEqual({
    ...defaultAccountSnapshot,
    enabled: true,
    stateReason: "not configured",
  });
});

describe("computed account status adapters", () => {
  it("builds account snapshots from async computed account metadata and extras", async () => {
    expect(await accountSnapshot("async")).toEqual({
      ...defaultAccountSnapshot,
      enabled: true,
      configured: true,
      running: true,
      probe: adapterProbe,
      profileUrl: adapterAccount.profileUrl,
      connected: true,
    });
  });

  it("preserves ingress failure for channel health evaluation", async () => {
    expect(
      evaluateChannelHealth(await accountSnapshot("sync", true), {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      }),
    ).toEqual({ healthy: false, reason: "ingress-unavailable" });
  });
});

describe("buildRuntimeAccountStatusSnapshot", () => {
  const connectivity = {
    connected: true,
    restartPending: true,
    reconnectAttempts: 3,
    lastConnectedAt: 11,
    lastDisconnect: { at: 12, error: "boom" },
    lastEventAt: 13,
    lastTransportActivityAt: 14,
    healthState: "reconnecting",
    lifecycle: "recovering" as const,
    ingressUnavailable: true as const,
    busy: true,
    activeRuns: 2,
    lastRunActivityAt: 15,
    activeRunStartedAt: 16,
    running: true,
  };
  it.each([
    connectivity,
    { running: false, lifecycle: "blocked" as const, terminalDisconnect: true },
  ])("projects runtime metadata: $lifecycle", (runtime) => {
    expect(buildRuntimeAccountStatusSnapshot({ runtime: structuredClone(runtime) })).toEqual({
      ...defaultRuntimeState,
      ...runtime,
      probe: undefined,
    });
  });
});

describe("buildTokenChannelStatusSummary", () => {
  const supplied = {
    configured: true,
    tokenSource: "env",
    running: true,
    lastStartAt: 1,
    lastStopAt: 2,
    lastError: "boom",
    probe: { ok: true },
    lastProbeAt: 3,
  };
  it.each([
    [
      "defaults",
      {},
      undefined,
      {
        configured: false,
        ...defaultRuntimeState,
        tokenSource: "none",
        mode: null,
        probe: undefined,
        lastProbeAt: null,
      },
    ],
    ["without mode", supplied, { includeMode: false }, supplied],
  ] as const)("builds token status %s", (_name, input, options, expected) => {
    expect(buildTokenChannelStatusSummary(structuredClone(input), options)).toEqual(expected);
  });
});

it("defaults mode to webhook and keeps supplied extras", () => {
  expect(
    buildWebhookChannelStatusSummary({ configured: true, running: true }, { secretSource: "env" }),
  ).toEqual({
    ...defaultRuntimeState,
    configured: true,
    running: true,
    mode: "webhook",
    secretSource: "env",
  });
});

it("uses source metadata from sanitized snapshots to pick the missing field", () => {
  const missingPrimaryMessage = "LINE channel access token not configured";
  const missingDependentMessage = "LINE channel secret not configured";
  const collect = createDependentCredentialStatusIssueCollector({
    channel: "line",
    dependencySourceKey: "tokenSource",
    missingPrimaryMessage,
    missingDependentMessage,
  });

  expect(
    collect([
      { accountId: "default", configured: false, tokenSource: "none" },
      { accountId: "work", configured: false, tokenSource: "env" },
      { accountId: "ok", configured: true, tokenSource: "env" },
    ]),
  ).toEqual([
    { channel: "line", accountId: "default", kind: "config", message: missingPrimaryMessage },
    { channel: "line", accountId: "work", kind: "config", message: missingDependentMessage },
  ]);
});

it("returns runtime issues only for non-empty string lastError values", () => {
  expect(
    collectStatusIssuesFromLastError("demo-channel", [
      { accountId: "default", lastError: " timeout " },
      { accountId: "silent", lastError: "   " },
      { accountId: "typed", lastError: { message: "boom" } },
    ]),
  ).toEqual([
    {
      channel: "demo-channel",
      accountId: "default",
      kind: "runtime",
      message: "Channel error: timeout",
    },
  ]);
});
