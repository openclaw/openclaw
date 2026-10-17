import { describe, expect, it } from "vitest";
import { evaluateChannelHealth } from "../gateway/channel-health-policy.js";
import {
  asString,
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
  it("preserves the shipped asString compatibility semantics", () => {
    expect(asString("  work  ")).toBe("work");
    expect(asString("   ")).toBeUndefined();
    expect(asString(42)).toBeUndefined();
  });

  it("coerces only standard and requested account fields", () => {
    expect(
      readAccountStatusSnapshot(
        { accountId: "work", enabled: true, configured: true, mode: "polling", secret: "drop" },
        ["mode"],
      ),
    ).toEqual({
      accountId: "work",
      enabled: true,
      configured: true,
      running: undefined,
      connected: undefined,
      mode: "polling",
    });
    expect(readAccountStatusSnapshot(null, ["mode"])).toBeNull();
  });

  it("builds standard open-policy and missing-auth issues", () => {
    expect(
      standardDmPolicyOpenIssue({
        channel: "zalo",
        accountId: "default",
        channelLabel: "Zalo",
        configPath: "channels.zalo",
      }),
    ).toEqual({
      channel: "zalo",
      accountId: "default",
      kind: "config",
      message: 'Zalo dmPolicy is "open", allowing any user to message the bot without pairing.',
      fix: 'Set channels.zalo.dmPolicy to "pairing" or "allowlist" to restrict access.',
    });
    expect(
      standardNotConfiguredIssue({
        channel: "zalouser",
        accountId: "default",
        message: "Not authenticated.",
        fix: "Run login.",
      }),
    ).toEqual({
      channel: "zalouser",
      accountId: "default",
      kind: "auth",
      message: "Not authenticated.",
      fix: "Run login.",
    });
  });
});

const defaultRuntimeState = {
  running: false,
  lastStartAt: null,
  lastStopAt: null,
  lastError: null,
};

const defaultChannelSummary = {
  configured: false,
  ...defaultRuntimeState,
};

const defaultTokenChannelSummary = {
  ...defaultChannelSummary,
  tokenSource: "none",
  mode: null,
  probe: undefined,
  lastProbeAt: null,
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

const adapterAccount = {
  accountId: "default",
  enabled: true,
  profileUrl: "https://example.test",
};

const adapterRuntime = {
  accountId: "default",
  running: true,
};

const adapterProbe = { ok: true };

const expectedAdapterAccountSnapshot = {
  ...defaultAccountSnapshot,
  enabled: true,
  configured: true,
  running: true,
  probe: adapterProbe,
  profileUrl: adapterAccount.profileUrl,
  connected: true,
};

function resolveAccountSnapshot({
  account,
  runtime,
  probe,
}: {
  account: typeof adapterAccount;
  runtime?: { running?: boolean };
  probe?: typeof adapterProbe;
}) {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: true,
    extra: { profileUrl: account.profileUrl, connected: runtime?.running ?? false, probe },
  };
}

function createComputedStatusAdapter() {
  return createComputedAccountStatusAdapter({
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot,
  });
}

function createAsyncStatusAdapter() {
  return createAsyncComputedAccountStatusAdapter({
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot: async (params: Parameters<typeof resolveAccountSnapshot>[0]) =>
      resolveAccountSnapshot(params),
  });
}

it("builds account status when configured is computed outside resolver", () => {
  expect(
    buildComputedAccountStatusSnapshot({
      accountId: "default",
      enabled: true,
      configured: false,
    }),
  ).toEqual({
    ...defaultAccountSnapshot,
    enabled: true,
    stateReason: "not configured",
  });
});

describe("computed account status adapters", () => {
  it("builds account snapshots from async computed account metadata and extras", async () => {
    const status = createAsyncStatusAdapter();
    await expect(
      Promise.resolve(
        status.buildAccountSnapshot?.({
          account: adapterAccount,
          cfg: {} as never,
          runtime: adapterRuntime,
          probe: adapterProbe,
        }),
      ),
    ).resolves.toEqual(expectedAdapterAccountSnapshot);
  });

  it("preserves ingress failure for channel health evaluation", async () => {
    const status = createComputedStatusAdapter();
    const snapshot = await status.buildAccountSnapshot!({
      account: adapterAccount,
      cfg: {} as never,
      runtime: {
        ...adapterRuntime,
        ingressUnavailable: true,
      },
      probe: adapterProbe,
    });

    expect(
      evaluateChannelHealth(snapshot, {
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
    {
      name: "preserves runtime connectivity metadata",
      input: { runtime: structuredClone(connectivity) },
      expected: {
        ...defaultRuntimeState,
        ...connectivity,
        probe: undefined,
      },
    },
    {
      name: "projects terminalDisconnect when set",
      input: {
        runtime: {
          running: false,
          lifecycle: "blocked" as const,
          terminalDisconnect: true,
        },
      },
      expected: {
        ...defaultRuntimeState,
        running: false,
        lifecycle: "blocked",
        terminalDisconnect: true,
        probe: undefined,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildRuntimeAccountStatusSnapshot(input)).toEqual(expected);
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
    {
      name: "includes token/probe fields with mode by default",
      input: {},
      options: undefined,
      expected: defaultTokenChannelSummary,
    },
    {
      name: "can omit mode for channels without a mode state",
      input: structuredClone(supplied),
      options: { includeMode: false },
      expected: supplied,
    },
  ])("$name", ({ input, options, expected }) => {
    expect(buildTokenChannelStatusSummary(input, options)).toEqual(expected);
  });
});

it("defaults mode to webhook and keeps supplied extras", () => {
  expect(
    buildWebhookChannelStatusSummary({ configured: true, running: true }, { secretSource: "env" }),
  ).toEqual({
    ...defaultChannelSummary,
    configured: true,
    running: true,
    mode: "webhook",
    secretSource: "env",
  });
});

it("uses source metadata from sanitized snapshots to pick the missing field", () => {
  const collect = createDependentCredentialStatusIssueCollector({
    channel: "line",
    dependencySourceKey: "tokenSource",
    missingPrimaryMessage: "LINE channel access token not configured",
    missingDependentMessage: "LINE channel secret not configured",
  });

  expect(
    collect([
      { accountId: "default", configured: false, tokenSource: "none" },
      { accountId: "work", configured: false, tokenSource: "env" },
      { accountId: "ok", configured: true, tokenSource: "env" },
    ]),
  ).toEqual([
    {
      channel: "line",
      accountId: "default",
      kind: "config",
      message: "LINE channel access token not configured",
    },
    {
      channel: "line",
      accountId: "work",
      kind: "config",
      message: "LINE channel secret not configured",
    },
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
