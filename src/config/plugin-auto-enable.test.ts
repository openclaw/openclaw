import { describe, expect, it } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";

describe("applyPluginAutoEnable", () => {
  it("auto-enables channel plugins and updates allowlist", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.changes.join("\n")).toContain("Slack configured, enabled automatically.");
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

  it("auto-enables irc when configured via env", () => {
    const result = applyPluginAutoEnable({
      config: {},
      env: {
        IRC_HOST: "irc.libera.chat",
        IRC_NICK: "openclaw-bot",
      },
    });

    expect(result.config.plugins?.entries?.irc?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("IRC configured, enabled automatically.");
  });

  it("auto-enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-antigravity:default": {
              provider: "google-antigravity",
              mode: "oauth",
            },
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.["google-antigravity-auth"]?.enabled).toBe(true);
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

  it("does not auto-enable bluebubbles when the channel is disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          bluebubbles: {
            enabled: false,
            serverUrl: "http://localhost:1234",
            password: "x",
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("does not auto-enable bluebubbles without explicit channel opt-in", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "x",
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("auto-enables bluebubbles only when explicitly opted in and configured", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://localhost:1234",
            password: "x",
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
    expect(result.changes.join("\n")).toContain("bluebubbles configured, enabled automatically.");
  });

  it("requires explicit bluebubbles account opt-in before auto-enable", () => {
    const missingAccountOptIn = applyPluginAutoEnable({
      config: {
        channels: {
          bluebubbles: {
            enabled: true,
            accounts: {
              personal: {
                serverUrl: "http://localhost:1234",
                password: "x",
              },
            },
          },
        },
      },
      env: {},
    });

    expect(missingAccountOptIn.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();

    const optedIn = applyPluginAutoEnable({
      config: {
        channels: {
          bluebubbles: {
            enabled: true,
            accounts: {
              personal: {
                enabled: true,
                serverUrl: "http://localhost:1234",
                password: "x",
              },
            },
          },
        },
      },
      env: {},
    });

    expect(optedIn.config.plugins?.entries?.bluebubbles?.enabled).toBe(true);
  });

  describe("preferOver channel prioritization", () => {
    it("prefers bluebubbles: skips imessage auto-configure when both are configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: {
              enabled: true,
              serverUrl: "http://localhost:1234",
              password: "x",
            },
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
            bluebubbles: {
              enabled: true,
              serverUrl: "http://localhost:1234",
              password: "x",
            },
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
            bluebubbles: {
              enabled: true,
              serverUrl: "http://localhost:1234",
              password: "x",
            },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { bluebubbles: { enabled: false } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });

    it("allows imessage auto-configure when bluebubbles is in deny list", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            bluebubbles: {
              enabled: true,
              serverUrl: "http://localhost:1234",
              password: "x",
            },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { deny: ["bluebubbles"] },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.bluebubbles?.enabled).toBeUndefined();
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("auto-enables imessage when only imessage is configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, enabled automatically.");
    });
  });
});
