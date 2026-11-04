// Status read-model tests cover channel status projection from runtime state.
import { describe, expect, it } from "vitest";
import {
  getRuntimeChannelAccounts,
  hasRuntimeCredentialAvailable,
  markConfiguredUnavailableCredentialStatusesAvailable,
  normalizeRuntimeChannelAccountSnapshots,
} from "./read-model.js";

describe("channel status read model", () => {
  it("normalizes gateway channel account snapshots by channel", () => {
    const accounts = normalizeRuntimeChannelAccountSnapshots({
      channelAccounts: {
        discord: [
          { accountId: "default", configured: true },
          { name: "missing-account-id", configured: true },
        ],
        slack: { accountId: "default" },
      },
    });

    expect(accounts.get("discord")).toStrictEqual([{ accountId: "default", configured: true }]);
    expect(accounts.has("slack")).toBe(false);
  });

  it("finds legacy live accounts by id/name fallback for status summaries", () => {
    const liveAccounts = getRuntimeChannelAccounts({
      payload: {
        channelAccounts: {
          discord: [{ name: "default", running: true }],
        },
      },
      channelId: "discord",
    });

    expect(hasRuntimeCredentialAvailable({ liveAccounts, accountId: "default" })).toBe(true);
  });

  it("does not treat unavailable runtime credentials as available", () => {
    const liveAccounts = [
      { accountId: "default", running: true, tokenStatus: "configured_unavailable" },
    ];

    expect(hasRuntimeCredentialAvailable({ liveAccounts, accountId: "default" })).toBe(false);
  });

  it("marks configured-unavailable credential statuses available for runtime-backed summaries", () => {
    expect(
      markConfiguredUnavailableCredentialStatusesAvailable({
        tokenStatus: "configured_unavailable",
        userTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
      }),
    ).toStrictEqual({
      tokenStatus: "available",
      userTokenStatus: "available",
      appTokenStatus: "missing",
    });
  });
});
