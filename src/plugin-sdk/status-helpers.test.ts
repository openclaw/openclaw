import { describe, expect, it } from "vitest";
import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildComputedAccountStatusSnapshot,
  buildRuntimeAccountStatusSnapshot,
  createComputedAccountStatusAdapter,
  buildTokenChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";

describe("createDefaultChannelRuntimeState", () => {
  it("builds default runtime state without extra fields", () => {
    expect(createDefaultChannelRuntimeState("default")).toEqual({
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    });
  });

  it("merges extra fields into the default runtime state", () => {
    expect(
      createDefaultChannelRuntimeState("alerts", {
        probeAt: 123,
        healthy: true,
      }),
    ).toEqual({
      accountId: "alerts",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probeAt: 123,
      healthy: true,
    });
  });
});

describe("buildBaseChannelStatusSummary", () => {
  it("defaults missing values", () => {
    expect(buildBaseChannelStatusSummary({})).toEqual({
      configured: false,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    });
  });

  it("keeps explicit values", () => {
    expect(
      buildBaseChannelStatusSummary({
        configured: true,
        running: true,
        lastStartAt: 1,
        lastStopAt: 2,
        lastError: "boom",
      }),
    ).toEqual({
      configured: true,
      running: true,
      lastStartAt: 1,
      lastStopAt: 2,
      lastError: "boom",
    });
  });

  it("merges extra fields into the normalized channel summary", () => {
    expect(
      buildBaseChannelStatusSummary(
        {
          configured: true,
        },
        {
          mode: "webhook",
          secretSource: "env",
        },
      ),
    ).toEqual({
      configured: true,
      mode: "webhook",
      secretSource: "env",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    });
  });
});

describe("buildBaseAccountStatusSnapshot", () => {
  it("builds account status with runtime defaults", () => {
    expect(
      buildBaseAccountStatusSnapshot({
        account: { accountId: "default", enabled: true, configured: true },
      }),
    ).toEqual({
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: true,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
      lastInboundAt: null,
      lastOutboundAt: null,
    });
  });

  it("merges extra snapshot fields after the shared account shape", () => {
    expect(
      buildBaseAccountStatusSnapshot(
        {
          account: { accountId: "default", configured: true },
        },
        {
          connected: true,
          mode: "polling",
        },
      ),
    ).toEqual({
      accountId: "default",
      name: undefined,
      enabled: undefined,
      configured: true,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
      lastInboundAt: null,
      lastOutboundAt: null,
      connected: true,
      mode: "polling",
    });
  });
});

describe("buildComputedAccountStatusSnapshot", () => {
  it("builds account status when configured is computed outside resolver", () => {
    expect(
      buildComputedAccountStatusSnapshot({
        accountId: "default",
        enabled: true,
        configured: false,
      }),
    ).toEqual({
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: false,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
      lastInboundAt: null,
      lastOutboundAt: null,
    });
  });

  it("merges computed extras after the shared fields", () => {
    expect(
      buildComputedAccountStatusSnapshot(
        {
          accountId: "default",
          configured: true,
        },
        {
          connected: true,
        },
      ),
    ).toEqual({
      accountId: "default",
      name: undefined,
      enabled: undefined,
      configured: true,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
      lastInboundAt: null,
      lastOutboundAt: null,
      connected: true,
    });
  });
});

describe("createComputedAccountStatusAdapter", () => {
  it("builds account snapshots from computed account metadata and extras", () => {
    const status = createComputedAccountStatusAdapter<
      { accountId: string; enabled: boolean; profileUrl: string },
      { ok: boolean }
    >({
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      resolveAccountSnapshot: ({ account, runtime, probe }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: true,
        extra: {
          profileUrl: account.profileUrl,
          connected: runtime?.running ?? false,
          probe,
        },
      }),
    });

    expect(
      status.buildAccountSnapshot?.({
        account: { accountId: "default", enabled: true, profileUrl: "https://example.test" },
        cfg: {} as never,
        runtime: { accountId: "default", running: true },
        probe: { ok: true },
      }),
    ).toEqual({
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: true,
      running: true,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: { ok: true },
      lastInboundAt: null,
      lastOutboundAt: null,
      profileUrl: "https://example.test",
      connected: true,
    });
  });
});

describe("buildRuntimeAccountStatusSnapshot", () => {
  it("builds runtime lifecycle fields with defaults", () => {
    expect(buildRuntimeAccountStatusSnapshot({})).toEqual({
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
    });
  });

  it("merges extra fields into runtime snapshots", () => {
    expect(buildRuntimeAccountStatusSnapshot({}, { port: 3978 })).toEqual({
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
      port: 3978,
    });
  });
});

describe("buildTokenChannelStatusSummary", () => {
  it("includes token/probe fields with mode by default", () => {
    expect(buildTokenChannelStatusSummary({})).toEqual({
      configured: false,
      tokenSource: "none",
      running: false,
      mode: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      probe: undefined,
      lastProbeAt: null,
    });
  });

  it("can omit mode for channels without a mode state", () => {
    expect(
      buildTokenChannelStatusSummary(
        {
          configured: true,
          tokenSource: "env",
          running: true,
          lastStartAt: 1,
          lastStopAt: 2,
          lastError: "boom",
          probe: { ok: true },
          lastProbeAt: 3,
        },
        { includeMode: false },
      ),
    ).toEqual({
      configured: true,
      tokenSource: "env",
      running: true,
      lastStartAt: 1,
      lastStopAt: 2,
      lastError: "boom",
      probe: { ok: true },
      lastProbeAt: 3,
    });
  });
});

describe("collectStatusIssuesFromLastError", () => {
  it("returns runtime issues only for non-empty string lastError values", () => {
    expect(
      collectStatusIssuesFromLastError("telegram", [
        { accountId: "default", lastError: " timeout " },
        { accountId: "silent", lastError: "   " },
        { accountId: "typed", lastError: { message: "boom" } },
      ]),
    ).toEqual([
      {
        channel: "telegram",
        accountId: "default",
        kind: "runtime",
        message: "Channel error: timeout",
      },
    ]);
  });
});
