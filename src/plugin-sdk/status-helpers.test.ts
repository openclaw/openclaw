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

  it("keeps open-policy warnings and remediation tied to the channel", () => {
    const issue = standardDmPolicyOpenIssue({
      channel: "zalo",
      accountId: "default",
      channelLabel: "Zalo",
      configPath: "channels.zalo",
    });
    expect(issue.message).toContain('Zalo dmPolicy is "open"');
    expect(issue.fix).toContain('Set channels.zalo.dmPolicy to "pairing" or "allowlist"');
  });
});

const defaultRuntimeState = {
  running: false,
  lastStartAt: null,
  lastStopAt: null,
  lastError: null,
};

it("builds account status when configured is computed outside resolver", () => {
  expect(
    buildComputedAccountStatusSnapshot({ accountId: "default", enabled: true, configured: false }),
  ).toMatchObject({
    accountId: "default",
    enabled: true,
    configured: false,
    stateReason: "not configured",
    lastInboundAt: null,
    lastOutboundAt: null,
  });
});

it.each(["sync", "async"] as const)(
  "%s account adapter projects metadata and ingress health",
  async (mode) => {
    const account = { accountId: "default", enabled: true, profileUrl: "https://example.test" };
    const probe = { ok: true };
    const resolve = (params: {
      account: typeof account;
      runtime?: { running?: boolean };
      probe?: typeof probe;
    }) => ({
      accountId: params.account.accountId,
      enabled: params.account.enabled,
      configured: true,
      extra: {
        profileUrl: params.account.profileUrl,
        connected: params.runtime?.running ?? false,
        probe: params.probe,
      },
    });
    const options = { defaultRuntime: createDefaultChannelRuntimeState("default") };
    const adapter =
      mode === "sync"
        ? createComputedAccountStatusAdapter({ ...options, resolveAccountSnapshot: resolve })
        : createAsyncComputedAccountStatusAdapter({
            ...options,
            resolveAccountSnapshot: async (params: Parameters<typeof resolve>[0]) =>
              resolve(params),
          });
    const snapshot = await adapter.buildAccountSnapshot!({
      account,
      cfg: {},
      probe,
      runtime: { accountId: "default", running: true, ingressUnavailable: true },
    });
    expect(snapshot).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      probe,
      profileUrl: account.profileUrl,
      connected: true,
    });
    expect(
      evaluateChannelHealth(snapshot, {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      }),
    ).toEqual({ healthy: false, reason: "ingress-unavailable" });
  },
);

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
