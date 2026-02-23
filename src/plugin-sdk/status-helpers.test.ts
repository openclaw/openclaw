import { describe, expect, it } from "vitest";
import {
  buildBaseChannelStatusSummary,
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
