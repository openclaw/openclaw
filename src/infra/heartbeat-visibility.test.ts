import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";

type Visibility = Partial<ReturnType<typeof resolveHeartbeatVisibility>>;
const defaults = { showOk: false, showAlerts: true, useIndicator: true };

function config(
  params: {
    defaults?: Visibility;
    channel?: Visibility;
    accounts?: Record<string, { heartbeatVisibility?: Visibility }>;
  } = {},
): OpenClawConfig {
  return {
    channels: {
      defaults: { heartbeatVisibility: params.defaults },
      telegram: { heartbeatVisibility: params.channel, accounts: params.accounts },
    },
  };
}

describe("resolveHeartbeatVisibility", () => {
  it("returns default values when no config is provided", () => {
    expect(resolveHeartbeatVisibility({ cfg: {}, channel: "telegram" })).toEqual(defaults);
  });

  it("uses channel defaults when provided", () => {
    const visibility = { showOk: true, showAlerts: false, useIndicator: false };
    expect(
      resolveHeartbeatVisibility({
        cfg: config({ defaults: visibility }),
        channel: "telegram",
      }),
    ).toEqual(visibility);
  });

  it("per-channel config overrides channel defaults", () => {
    expect(
      resolveHeartbeatVisibility({
        cfg: config({ defaults, channel: { showOk: true, useIndicator: false } }),
        channel: "telegram",
      }),
    ).toEqual({ showOk: true, showAlerts: true, useIndicator: false });
  });

  it("per-account config overrides per-channel config", () => {
    expect(
      resolveHeartbeatVisibility({
        cfg: config({
          defaults,
          channel: { showOk: false, showAlerts: false },
          accounts: { primary: { heartbeatVisibility: { showOk: true, showAlerts: true } } },
        }),
        channel: "telegram",
        accountId: "primary",
      }),
    ).toEqual({ ...defaults, showOk: true });
  });

  it("falls through to defaults when account has no heartbeat config", () => {
    expect(
      resolveHeartbeatVisibility({
        cfg: config({
          defaults: { showOk: false },
          channel: { showAlerts: false },
          accounts: { primary: {} },
        }),
        channel: "telegram",
        accountId: "primary",
      }),
    ).toEqual({ ...defaults, showAlerts: false });
  });

  it("handles missing accountId gracefully", () => {
    expect(
      resolveHeartbeatVisibility({
        cfg: config({
          channel: { showOk: true },
          accounts: { primary: { heartbeatVisibility: { showOk: false } } },
        }),
        channel: "telegram",
      }).showOk,
    ).toBe(true);
  });

  it("handles non-existent account gracefully", () => {
    expect(
      resolveHeartbeatVisibility({
        cfg: config({
          channel: { showOk: true },
          accounts: { primary: { heartbeatVisibility: { showOk: false } } },
        }),
        channel: "telegram",
        accountId: "nonexistent",
      }).showOk,
    ).toBe(true);
  });

  it("webchat uses channel defaults and ignores accountId", () => {
    const visibility = { showOk: true, showAlerts: false, useIndicator: false };
    expect(
      resolveHeartbeatVisibility({
        cfg: config({ defaults: visibility }),
        channel: "webchat",
        accountId: "some-account",
      }),
    ).toEqual(visibility);
  });

  it("webchat returns defaults when no channel defaults configured", () => {
    expect(resolveHeartbeatVisibility({ cfg: {}, channel: "webchat" })).toEqual(defaults);
  });
});
