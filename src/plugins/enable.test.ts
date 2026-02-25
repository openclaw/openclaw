import { describe, expect, it } from "vitest";
import type { ActiviConfig } from "../config/config.js";
import { enablePluginInConfig } from "./enable.js";

describe("enablePluginInConfig", () => {
  it("enables a plugin entry", () => {
    const cfg: ActiviConfig = {};
    const result = enablePluginInConfig(cfg, "google-antigravity-auth");
    expect(result.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["google-antigravity-auth"]?.enabled).toBe(true);
  });

  it("adds plugin to allowlist when allowlist is configured", () => {
    const cfg: ActiviConfig = {
      plugins: {
        allow: ["memory-core"],
      },
    };
    const result = enablePluginInConfig(cfg, "google-antigravity-auth");
    expect(result.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["memory-core", "google-antigravity-auth"]);
  });

  it("refuses enable when plugin is denylisted", () => {
    const cfg: ActiviConfig = {
      plugins: {
        deny: ["google-antigravity-auth"],
      },
    };
    const result = enablePluginInConfig(cfg, "google-antigravity-auth");
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("blocked by denylist");
  });
});
