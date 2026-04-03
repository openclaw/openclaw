import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFirstVisibleWatchdogStrategy } from "./first-visible-watchdog.js";

describe("resolveFirstVisibleWatchdogStrategy", () => {
  it("disables the watchdog when diagnostics are off", () => {
    expect(
      resolveFirstVisibleWatchdogStrategy({
        cfg: {} as OpenClawConfig,
        channel: "feishu",
      }),
    ).toEqual({
      mode: "disabled",
      reason: "diagnostics_disabled",
    });
  });

  it("disables the watchdog for non-routable channels", () => {
    expect(
      resolveFirstVisibleWatchdogStrategy({
        cfg: {
          diagnostics: {
            enabled: true,
          },
        } as OpenClawConfig,
        channel: "internal_webchat",
      }),
    ).toEqual({
      mode: "disabled",
      reason: "non_routable_channel",
    });
  });

  it("uses diagnose-only mode for routable channels", () => {
    expect(
      resolveFirstVisibleWatchdogStrategy({
        cfg: {
          diagnostics: {
            enabled: true,
            firstVisibleWarnMs: 6_000,
          },
        } as OpenClawConfig,
        channel: "telegram",
      }),
    ).toEqual({
      mode: "diagnose_only",
      thresholdMs: 6_000,
    });
  });
});
