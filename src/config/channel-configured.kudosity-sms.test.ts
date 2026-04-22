/**
 * Regression tests for Kudosity SMS channel detection.
 *
 * The bundled `kudosity-sms` plugin supports env-only credentials via
 * `KUDOSITY_API_KEY` + `KUDOSITY_SENDER`. `isChannelConfigured` must recognize
 * those env vars so `plugin-auto-enable` can flip the plugin on at startup in
 * env-only deployments (no `channels.kudosity-sms.apiKey` in config.json).
 */

import { describe, expect, it } from "vitest";
import { isChannelConfigured } from "./channel-configured.js";
import type { OpenClawConfig } from "./config.js";

function makeCfg(channels: Record<string, unknown> = {}): OpenClawConfig {
  return { channels } as OpenClawConfig;
}

describe("isChannelConfigured (kudosity-sms)", () => {
  it("returns true when both env vars are set even without any config entry", () => {
    const cfg = makeCfg({});
    expect(
      isChannelConfigured(cfg, "kudosity-sms", {
        KUDOSITY_API_KEY: "k-demo-123", // pragma: allowlist secret
        KUDOSITY_SENDER: "+61400000000",
      }),
    ).toBe(true);
  });

  it("returns false when only one env var is set (envAll semantics)", () => {
    const cfg = makeCfg({});
    expect(
      isChannelConfigured(cfg, "kudosity-sms", {
        KUDOSITY_API_KEY: "k-demo-123", // pragma: allowlist secret
      }),
    ).toBe(false);
    expect(
      isChannelConfigured(cfg, "kudosity-sms", {
        KUDOSITY_SENDER: "+61400000000",
      }),
    ).toBe(false);
  });

  it("returns true when apiKey + sender are set via the nested config section", () => {
    const cfg = makeCfg({
      "kudosity-sms": {
        apiKey: "config-key", // pragma: allowlist secret
        sender: "+61400000000",
      },
    });
    expect(isChannelConfigured(cfg, "kudosity-sms", {})).toBe(true);
  });

  it("returns true when credentials are set on a named account", () => {
    const cfg = makeCfg({
      "kudosity-sms": {
        accounts: {
          primary: {
            apiKey: "acct-key", // pragma: allowlist secret
            sender: "+61400000000",
          },
        },
      },
    });
    expect(isChannelConfigured(cfg, "kudosity-sms", {})).toBe(true);
  });

  it("returns false when the channels entry is empty and env is empty", () => {
    const cfg = makeCfg({});
    expect(isChannelConfigured(cfg, "kudosity-sms", {})).toBe(false);
  });

  it("returns false when only `enabled: false` is present and env is empty", () => {
    const cfg = makeCfg({ "kudosity-sms": { enabled: false } });
    expect(isChannelConfigured(cfg, "kudosity-sms", {})).toBe(false);
  });
});
