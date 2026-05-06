import { describe, expect, it } from "vitest";
import { mergeChannelsTableWithGatewayStatus } from "./channels.js";

describe("mergeChannelsTableWithGatewayStatus (issue #73525)", () => {
  it("synthesizes a row from channels.status accountAccounts when read-only discovery returned none", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelLabels: { telegram: "Telegram" },
        channelAccounts: {
          telegram: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
              mode: "polling",
            },
          ],
        },
      },
    });

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]).toMatchObject({
      id: "telegram",
      label: "Telegram",
      enabled: true,
      state: "ok",
    });
    expect(merged.rows[0]?.detail).toContain("running");
  });

  it("aggregates state across multiple gateway accounts under one row", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          telegram: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
            },
            {
              accountId: "8679192687",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
            },
          ],
        },
      },
    });

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]).toMatchObject({
      id: "telegram",
      enabled: true,
      state: "ok",
    });
    expect(merged.rows[0]?.detail).toContain("accounts 2");
  });

  it("treats lastError as the highest-precedence signal even when other fields look healthy", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          telegram: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
              lastError: "auth refresh failed",
            },
          ],
        },
      },
    });

    expect(merged.rows[0]).toMatchObject({ id: "telegram", state: "warn" });
    expect(merged.rows[0]?.detail).toContain("auth refresh failed");
  });

  it("flags warn when an account reports lastError", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          discord: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: false,
              lastError: "websocket disconnected",
            },
          ],
        },
      },
    });

    expect(merged.rows[0]).toMatchObject({
      id: "discord",
      state: "warn",
    });
    expect(merged.rows[0]?.detail).toContain("websocket disconnected");
  });

  it("preserves existing rows untouched when their channel id is also present in the gateway payload", () => {
    const existingRow = {
      id: "signal" as const,
      label: "Signal Custom",
      enabled: true,
      state: "ok" as const,
      detail: "linked · auth fresh",
    };
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [existingRow], details: [] },
      channelsStatus: {
        channelAccounts: {
          signal: [{ accountId: "default", enabled: true, running: true, connected: true }],
          telegram: [{ accountId: "default", enabled: true, running: true, connected: true }],
        },
      },
    });

    expect(merged.rows).toHaveLength(2);
    expect(merged.rows[0]).toBe(existingRow);
    expect(merged.rows[1]?.id).toBe("telegram");
  });

  it("returns the original table when channelsStatus is null or has no channelAccounts", () => {
    const channels = { rows: [], details: [] };
    expect(mergeChannelsTableWithGatewayStatus({ channels, channelsStatus: null })).toBe(channels);
    expect(
      mergeChannelsTableWithGatewayStatus({ channels, channelsStatus: { channelAccounts: {} } }),
    ).toBe(channels);
    expect(mergeChannelsTableWithGatewayStatus({ channels, channelsStatus: {} })).toBe(channels);
  });

  it("skips synthesized rows when all gateway accounts for a channel are disabled", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          telegram: [{ accountId: "default", enabled: false }],
        },
      },
    });

    expect(merged.rows).toEqual([]);
  });

  it("ignores disabled accounts when aggregating state across mixed accounts", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          telegram: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
            },
            { accountId: "stale", enabled: false, running: false, connected: false },
          ],
        },
      },
    });

    expect(merged.rows[0]).toMatchObject({ id: "telegram", state: "ok" });
    expect(merged.rows[0]?.detail).toBe("running");
  });

  it("emits a setup state when accounts are running and connected but not configured", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          telegram: [
            {
              accountId: "default",
              enabled: true,
              configured: false,
              running: true,
              connected: true,
            },
          ],
        },
      },
    });

    expect(merged.rows[0]).toMatchObject({ id: "telegram", state: "setup" });
    expect(merged.rows[0]?.detail).toContain("not configured");
  });

  it("falls back to the channel id verbatim when channelLabels is missing the channel", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelLabels: { signal: "Signal" },
        channelAccounts: {
          telegram: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
            },
          ],
        },
      },
    });

    expect(merged.rows[0]).toMatchObject({ id: "telegram", label: "telegram" });
  });

  it("does not crash on malformed account entries and skips them", () => {
    const merged = mergeChannelsTableWithGatewayStatus({
      channels: { rows: [], details: [] },
      channelsStatus: {
        channelAccounts: {
          telegram: [
            null,
            42,
            "oops",
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
            },
          ],
        },
      },
    });

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0]).toMatchObject({ id: "telegram", state: "ok" });
  });
});
