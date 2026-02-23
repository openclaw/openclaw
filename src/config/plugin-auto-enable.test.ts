import { describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";

describe("applyPluginAutoEnable", () => {
  it("auto-enables built-in channels and appends to existing allowlist", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env: {},
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
  });

  it("does not create plugins.allow when allowlist is unset", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
      },
      env: {},
    });

    expect(result.config.channels?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toBeUndefined();
  });

  it("ignores channels.modelByChannel for plugin auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          modelByChannel: {
            openai: {
              whatsapp: "openai/gpt-5.2",
            },
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.modelByChannel).toBeUndefined();
    expect(result.config.plugins?.allow).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false } } },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("respects built-in channel explicit disable via channels.<id>.enabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x", enabled: false } },
      },
      env: {},
    });

    expect(result.config.channels?.slack?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.slack).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("auto-enables irc when configured via env", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: {
        IRC_HOST: "irc.libera.chat",
        IRC_NICK: "openclaw-bot",
      },
    });

    expect(result.config.channels?.irc?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("IRC configured, enabled automatically.");
  });

  it("auto-enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-gemini-cli:default": {
              provider: "google-gemini-cli",
              mode: "oauth",
            },
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.["google-gemini-cli-auth"]?.enabled).toBe(true);
  });

  it("skips when plugins are globally disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  describe("preferOver channel prioritization", () => {
    it("prefers bluebubbles: skips imessage auto-configure when both are configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBeUndefined();
      expect(result.changes.join("\n")).toContain("bluebubbles configured, enabled automatically.");
      expect(result.changes.join("\n")).not.toContain(
        "iMessage configured, enabled automatically.",
      );
    });

    it("keeps imessage enabled if already explicitly enabled (non-destructive)", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { imessage: { enabled: true } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("allows imessage auto-configure when bluebubbles is explicitly disabled", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { bluebubbles: { enabled: false } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(false);
      expect(result.config.channels?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });

    it("allows imessage auto-configure when bluebubbles is in deny list", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { deny: ["bluebubbles"] },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();
      expect(result.config.channels?.imessage?.enabled).toBe(true);
    });

    it("auto-enables imessage when only imessage is configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
        },
        env: {},
      });

      expect(result.config.channels?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });
  });
});
