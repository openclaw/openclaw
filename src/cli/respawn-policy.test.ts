import { describe, expect, it } from "vitest";
import { shouldSkipRespawnForArgv } from "./respawn-policy.js";

const argv = (...args: string[]) => ["node", "openclaw", ...args];

describe("shouldSkipRespawnForArgv", () => {
  describe("always skips for help / version flags", () => {
    it.each(["--help", "-h", "--version", "-V"])("skips for %s", (flag) => {
      expect(shouldSkipRespawnForArgv(argv(flag))).toBe(true);
    });

    it("skips for gateway --help", () => {
      expect(shouldSkipRespawnForArgv(argv("gateway", "--help"))).toBe(true);
    });
  });

  describe("respawns for commands that use experimental APIs", () => {
    it.each(["gateway", "daemon", "agent", "memory"])("respawns for %s", (cmd) => {
      expect(shouldSkipRespawnForArgv(argv(cmd))).toBe(false);
    });

    it("respawns for gateway run", () => {
      expect(shouldSkipRespawnForArgv(argv("gateway", "run"))).toBe(false);
    });

    it("respawns for memory search", () => {
      expect(shouldSkipRespawnForArgv(argv("memory", "search", "hello"))).toBe(false);
    });
  });

  describe("skips respawn for short-lived CLI commands", () => {
    it.each([
      "config",
      "configure",
      "setup",
      "onboard",
      "status",
      "health",
      "channels",
      "pairing",
      "models",
      "message",
      "mcp",
      "browser",
      "doctor",
      "plugins",
      "update",
      "sessions",
      "secrets",
      "security",
      "backup",
      "completion",
      "qr",
      "nodes",
      "devices",
      "acp",
      "hooks",
      "webhooks",
      "logs",
      "system",
      "tui",
      "sandbox",
      "skills",
      "directory",
      "dns",
      "docs",
      "cron",
    ])("skips for %s", (cmd) => {
      expect(shouldSkipRespawnForArgv(argv(cmd))).toBe(true);
    });
  });

  it("skips for bare openclaw invocation (no subcommand)", () => {
    expect(shouldSkipRespawnForArgv(argv())).toBe(true);
  });

  it("skips for unknown commands (safe default)", () => {
    expect(shouldSkipRespawnForArgv(argv("some-future-command"))).toBe(true);
  });

  describe("handles root options before command", () => {
    it("respawns for --dev gateway", () => {
      expect(shouldSkipRespawnForArgv(argv("--dev", "gateway"))).toBe(false);
    });
    it("respawns for --profile test memory search", () => {
      expect(shouldSkipRespawnForArgv(argv("--profile", "test", "memory", "search"))).toBe(false);
    });
    it("skips for --dev config get", () => {
      expect(shouldSkipRespawnForArgv(argv("--dev", "config", "get"))).toBe(true);
    });
    it("skips for --profile test pairing list", () => {
      expect(shouldSkipRespawnForArgv(argv("--profile", "test", "pairing", "list"))).toBe(true);
    });
  });
});
