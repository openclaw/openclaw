import { describe, expect, it } from "vitest";
import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
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
