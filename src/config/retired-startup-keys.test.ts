import { describe, expect, it } from "vitest";
import { stripRetiredStartupKeys } from "./retired-startup-keys.js";

describe("stripRetiredStartupKeys", () => {
  it("drops supervisor-rewritten retired keys and keeps the rest of the config", () => {
    const config = {
      meta: { lastTouchedAt: "2026-11-05T00:00:00.000Z", lastTouchedVersion: "2026.10.9" },
      gateway: {
        mode: "local",
        controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
      },
      plugins: { installs: {}, entries: { telegram: {} } },
    };

    expect(stripRetiredStartupKeys(config)).toBe(true);
    expect(config.meta).toEqual({ lastTouchedVersion: "2026.10.9" });
    expect(config.gateway.controlUi).toEqual({ dangerouslyDisableDeviceAuth: false });
    expect(config.plugins).toEqual({ entries: { telegram: {} } });
    expect(config.gateway.mode).toBe("local");
  });

  it("removes an object that only held retired keys", () => {
    const config = {
      meta: { lastTouchedAt: "2026-11-05T00:00:00.000Z" },
      plugins: { installs: {} },
    };

    expect(stripRetiredStartupKeys(config)).toBe(true);
    expect(config).toEqual({});
  });

  it("leaves a config that has no retired keys alone", () => {
    const config = { gateway: { mode: "local" } };
    expect(stripRetiredStartupKeys(config)).toBe(false);
    expect(config).toEqual({ gateway: { mode: "local" } });
  });
});
