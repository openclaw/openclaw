import { describe, expect, it } from "vitest";
import {
  buildFallbackConventionDetails,
  resolveFallbackConventionConfigured,
} from "./channel-summary-fallback-conventions.js";

describe("channel-summary fallback conventions", () => {
  it("applies configured/detail rules for supported extension channels", () => {
    expect(
      resolveFallbackConventionConfigured("zulip", {
        botEmail: "bot@zulip.example.com",
        botApiKey: "zulip-api-key",
        baseUrl: "https://zulip.example.com",
      }),
    ).toBe(true);
    expect(
      buildFallbackConventionDetails("zulip", {
        botEmail: "bot@zulip.example.com",
      }),
    ).toEqual(["email:bot@zulip.example.com"]);

    expect(
      resolveFallbackConventionConfigured("twitch", {
        username: "openclawbot",
        accessToken: "oauth:test123",
        clientId: "twitch-client-id",
        channel: "lionrootstudio",
      }),
    ).toBe(true);
    expect(
      buildFallbackConventionDetails("twitch", {
        username: "openclawbot",
        accessToken: "oauth:test123",
        clientId: "twitch-client-id",
        channel: "lionrootstudio",
      }),
    ).toEqual([
      "user:openclawbot",
      "channel:lionrootstudio",
      "token:config",
      "client:config",
    ]);

    expect(
      resolveFallbackConventionConfigured("matrix", {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-matrix",
      }),
    ).toBe(true);
    expect(
      buildFallbackConventionDetails("matrix", {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-matrix",
      }),
    ).toEqual([
      "user:@bot:example.org",
      "homeserver:https://matrix.example.org",
      "token:config",
    ]);

    expect(
      resolveFallbackConventionConfigured("msteams", {
        appId: "teams-app-id",
        appPassword: "teams-password",
        tenantId: "tenant-123",
      }),
    ).toBe(true);
    expect(
      buildFallbackConventionDetails("msteams", {
        appId: "teams-app-id",
        appPassword: "teams-password",
        tenantId: "tenant-123",
      }),
    ).toEqual(["tenant:tenant-123", "app:config", "password:config"]);

    expect(
      resolveFallbackConventionConfigured("synology-chat", {
        token: "synology-token",
        incomingUrl: "https://nas.example.com/webapi/entry.cgi",
        nasHost: "nas.example.com",
        botName: "OpenClaw NAS",
      }),
    ).toBe(true);
    expect(
      buildFallbackConventionDetails("synology-chat", {
        token: "synology-token",
        incomingUrl: "https://nas.example.com/webapi/entry.cgi",
        nasHost: "nas.example.com",
        botName: "OpenClaw NAS",
      }),
    ).toEqual(["bot:OpenClaw NAS", "nas:nas.example.com", "token:config", "incoming:config"]);
  });

  it("returns undefined/empty for unsupported channels", () => {
    expect(resolveFallbackConventionConfigured("unknown-channel", { foo: "bar" })).toBeUndefined();
    expect(buildFallbackConventionDetails("unknown-channel", { foo: "bar" })).toEqual([]);
  });
});
