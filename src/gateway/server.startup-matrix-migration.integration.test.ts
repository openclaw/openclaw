import { describe, expect, it } from "vitest";
import { resolveGatewayStartupMaintenanceConfig } from "./server-startup-plugins.js";

const repairedChannels = {
  matrix: {
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "tok-123",
  },
};

describe("gateway startup channel maintenance wiring", () => {
  it("uses channels supplied by startup recovery", () => {
    const resolved = resolveGatewayStartupMaintenanceConfig({
      cfgAtStart: { plugins: { enabled: true } },
      startupRuntimeConfig: { plugins: { enabled: true }, channels: repairedChannels },
    });
    expect(resolved.channels).toEqual(repairedChannels);
  });

  it("preserves explicit startup channels", () => {
    const channels = {
      matrix: {
        homeserver: "https://matrix.original.example",
        userId: "@original:example.org",
        accessToken: "original-token",
      },
    };
    const resolved = resolveGatewayStartupMaintenanceConfig({
      cfgAtStart: { plugins: { enabled: true }, channels },
      startupRuntimeConfig: { plugins: { enabled: true }, channels: repairedChannels },
    });
    expect(resolved.channels).toEqual(channels);
  });
});
