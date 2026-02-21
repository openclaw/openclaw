import { describe, expect, it } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

describe("browserless reconnect config", () => {
  // ── Default values ──────────────────────────────────────────────────

  describe("defaults", () => {
    it("defaults browserlessReconnect to false", () => {
      const resolved = resolveBrowserConfig(undefined);
      expect(resolved.browserlessReconnect).toBe(false);
    });

    it("defaults browserlessReconnectTimeoutMs to 60000", () => {
      const resolved = resolveBrowserConfig(undefined);
      expect(resolved.browserlessReconnectTimeoutMs).toBe(60_000);
    });

    it("defaults browserlessReconnect to false when browserless block is empty", () => {
      const resolved = resolveBrowserConfig({ browserless: {} });
      expect(resolved.browserlessReconnect).toBe(false);
    });

    it("defaults browserlessReconnectTimeoutMs to 60000 when browserless block is empty", () => {
      const resolved = resolveBrowserConfig({ browserless: {} });
      expect(resolved.browserlessReconnectTimeoutMs).toBe(60_000);
    });
  });

  // ── Explicit global config ──────────────────────────────────────────

  describe("explicit global config", () => {
    it("sets browserlessReconnect to true when configured", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: true },
      });
      expect(resolved.browserlessReconnect).toBe(true);
    });

    it("keeps browserlessReconnect false when explicitly set to false", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: false },
      });
      expect(resolved.browserlessReconnect).toBe(false);
    });

    it("overrides timeout when configured", () => {
      const resolved = resolveBrowserConfig({
        browserless: { timeout: 120_000 },
      });
      expect(resolved.browserlessReconnectTimeoutMs).toBe(120_000);
    });

    it("falls back to default timeout for negative values", () => {
      const resolved = resolveBrowserConfig({
        browserless: { timeout: -1 },
      });
      expect(resolved.browserlessReconnectTimeoutMs).toBe(60_000);
    });

    it("falls back to default timeout for NaN", () => {
      const resolved = resolveBrowserConfig({
        browserless: { timeout: Number.NaN },
      });
      expect(resolved.browserlessReconnectTimeoutMs).toBe(60_000);
    });

    it("floors fractional timeout values", () => {
      const resolved = resolveBrowserConfig({
        browserless: { timeout: 45_500.7 },
      });
      expect(resolved.browserlessReconnectTimeoutMs).toBe(45_500);
    });

    it("allows zero timeout", () => {
      const resolved = resolveBrowserConfig({
        browserless: { timeout: 0 },
      });
      expect(resolved.browserlessReconnectTimeoutMs).toBe(0);
    });
  });

  // ── Profile-level resolution via resolveProfile ─────────────────────

  describe("profile-level resolution", () => {
    it("profile inherits global browserlessReconnect when not overridden", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: true, timeout: 30_000 },
        profiles: {
          remote: { cdpUrl: "http://remote.example.com:9222", color: "#00FF00" },
        },
      });

      const profile = resolveProfile(resolved, "remote");
      expect(profile).not.toBeNull();
      expect(profile!.browserlessReconnect).toBe(true);
      expect(profile!.browserlessReconnectTimeoutMs).toBe(30_000);
    });

    it("profile-level browserless.reconnect overrides global", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: true },
        profiles: {
          remote: {
            cdpUrl: "http://remote.example.com:9222",
            color: "#00FF00",
            browserless: { reconnect: false },
          },
        },
      });

      const profile = resolveProfile(resolved, "remote");
      expect(profile!.browserlessReconnect).toBe(false);
    });

    it("profile-level browserless.reconnect enables when global is disabled", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: false },
        profiles: {
          remote: {
            cdpUrl: "http://remote.example.com:9222",
            color: "#00FF00",
            browserless: { reconnect: true },
          },
        },
      });

      const profile = resolveProfile(resolved, "remote");
      expect(profile!.browserlessReconnect).toBe(true);
    });

    it("profile-level timeout overrides global timeout", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: true, timeout: 60_000 },
        profiles: {
          remote: {
            cdpUrl: "http://remote.example.com:9222",
            color: "#00FF00",
            browserless: { timeout: 120_000 },
          },
        },
      });

      const profile = resolveProfile(resolved, "remote");
      expect(profile!.browserlessReconnectTimeoutMs).toBe(120_000);
    });

    it("profile inherits global timeout when profile timeout is not set", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: true, timeout: 45_000 },
        profiles: {
          remote: {
            cdpUrl: "http://remote.example.com:9222",
            color: "#00FF00",
            browserless: { reconnect: true },
          },
        },
      });

      const profile = resolveProfile(resolved, "remote");
      expect(profile!.browserlessReconnectTimeoutMs).toBe(45_000);
    });
  });

  // ── Loopback safety guard ───────────────────────────────────────────

  describe("loopback safety guard", () => {
    it("forces browserlessReconnect to false for localhost cdpUrl", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: true },
        profiles: {
          local: { cdpUrl: "http://localhost:9222", color: "#00FF00" },
        },
      });

      const profile = resolveProfile(resolved, "local");
      expect(profile).not.toBeNull();
      expect(profile!.cdpIsLoopback).toBe(true);
      expect(profile!.browserlessReconnect).toBe(false);
    });

    it("forces browserlessReconnect to false for 127.0.0.1 cdpUrl", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: true },
        profiles: {
          local: { cdpUrl: "http://127.0.0.1:9222", color: "#00FF00" },
        },
      });

      const profile = resolveProfile(resolved, "local");
      expect(profile!.cdpIsLoopback).toBe(true);
      expect(profile!.browserlessReconnect).toBe(false);
    });

    it("forces browserlessReconnect to false for 127.0.0.1 even with profile-level reconnect:true", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: true },
        profiles: {
          local: {
            cdpUrl: "http://127.0.0.1:9222",
            color: "#00FF00",
            browserless: { reconnect: true },
          },
        },
      });

      const profile = resolveProfile(resolved, "local");
      expect(profile!.browserlessReconnect).toBe(false);
    });

    it("allows browserlessReconnect for non-loopback addresses", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: true },
        profiles: {
          remote: {
            cdpUrl: "http://remote.example.com:9222",
            color: "#00FF00",
          },
        },
      });

      const profile = resolveProfile(resolved, "remote");
      expect(profile!.cdpIsLoopback).toBe(false);
      expect(profile!.browserlessReconnect).toBe(true);
    });

    it("allows browserlessReconnect for private network (non-loopback) addresses", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://10.0.0.42:9222",
        browserless: { reconnect: true },
        profiles: {
          lan: {
            cdpUrl: "http://10.0.0.42:9222",
            color: "#00FF00",
          },
        },
      });

      const profile = resolveProfile(resolved, "lan");
      expect(profile!.cdpIsLoopback).toBe(false);
      expect(profile!.browserlessReconnect).toBe(true);
    });

    it("forces reconnect to false for default openclaw profile (loopback by default)", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: true },
      });

      const profile = resolveProfile(resolved, "openclaw");
      expect(profile).not.toBeNull();
      expect(profile!.cdpIsLoopback).toBe(true);
      expect(profile!.browserlessReconnect).toBe(false);
    });

    it("forces reconnect to false for default chrome extension profile (loopback)", () => {
      const resolved = resolveBrowserConfig({
        browserless: { reconnect: true },
      });

      const profile = resolveProfile(resolved, "chrome");
      expect(profile).not.toBeNull();
      expect(profile!.cdpIsLoopback).toBe(true);
      expect(profile!.browserlessReconnect).toBe(false);
    });
  });

  // ── Mixed profiles (loopback + remote) ──────────────────────────────

  describe("mixed loopback and remote profiles", () => {
    it("only the remote profile gets browserlessReconnect:true", () => {
      const resolved = resolveBrowserConfig({
        cdpUrl: "http://remote.example.com:9222",
        browserless: { reconnect: true, timeout: 90_000 },
        profiles: {
          local: { cdpUrl: "http://127.0.0.1:9222", color: "#FF0000" },
          remote: { cdpUrl: "http://remote.example.com:9222", color: "#00FF00" },
        },
      });

      const local = resolveProfile(resolved, "local");
      const remote = resolveProfile(resolved, "remote");

      expect(local!.browserlessReconnect).toBe(false);
      expect(local!.browserlessReconnectTimeoutMs).toBe(90_000);

      expect(remote!.browserlessReconnect).toBe(true);
      expect(remote!.browserlessReconnectTimeoutMs).toBe(90_000);
    });
  });
});
