import { expect, it } from "vitest";
import { stripRetiredStartupKeys } from "./retired-startup-keys.js";

it("strips retired startup keys, preserves siblings, and prunes emptied containers", () => {
  const config = {
    meta: { lastTouchedAt: "2026-11-05T00:00:00.000Z", lastTouchedVersion: "2026.10.9" },
    gateway: {
      controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
    },
    plugins: { installs: {}, entries: { telegram: {} } },
  };
  stripRetiredStartupKeys(config);
  expect(config.meta).toEqual({ lastTouchedVersion: "2026.10.9" });
  expect(config.gateway.controlUi).toEqual({ dangerouslyDisableDeviceAuth: false });
  expect(config.plugins).toEqual({ entries: { telegram: {} } });

  const empty = { meta: { lastTouchedAt: "old" }, plugins: { installs: {} } };
  stripRetiredStartupKeys(empty);
  expect(empty).toEqual({});
});
