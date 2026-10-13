// Status overview surface tests cover JSON and terminal rows derived from shared overview surfaces.
import { describe, expect, it } from "vitest";
import {
  buildGatewayStatusJsonPayload,
  buildStatusOverviewSurfaceRows,
  buildStatusUpdateSurface,
} from "./status-all/format.js";
import {
  baseStatusCfg,
  baseStatusExpectedUpdateChannelLabel,
  baseStatusOverviewSurface,
} from "./status.test-support.ts";

describe("status-overview-surface", () => {
  it("shows the app owner and its update hint without offering a package update", () => {
    const update = buildStatusUpdateSurface({
      update: {
        root: "/Applications/OpenClaw.app/Contents/Resources/openclaw",
        installKind: "host",
        packageManager: "unknown",
        installOwner: {
          schemaVersion: 1,
          owner: "macos-app",
          displayName: "OpenClaw.app",
          updateHint: "Update OpenClaw.app to update this Gateway.",
        },
      },
    });

    expect(update.updateLine).toBe(
      "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
    );
    expect(update.updateAvailable).toBe(false);
    expect(update.gitLabel).toBeNull();
  });
  it("builds overview rows from the shared surface bundle", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        cfg: baseStatusCfg,
        update: {
          installKind: "git",
          git: {
            branch: "main",
            tag: "v1.2.3",
            upstream: "origin/main",
            behind: 2,
            ahead: 0,
            dirty: false,
            fetchOk: true,
          },
          registry: { latestVersion: "2026.4.10" },
        } as never,
        tailscaleMode: "off",
        tailscaleHttpsUrl: null,
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
        prefixRows: [{ Item: "OS", Value: "macOS · node 22" }],
        suffixRows: [{ Item: "Secrets", Value: "none" }],
        agentsValue: "2 total",
        updateValue: "available · custom update",
        gatewayAuthWarningValue: "warn(warn-text)",
        gatewaySelfFallbackValue: "gateway-self",
        includeDnsNameWhenOff: true,
        decorateOk: (value) => `ok(${value})`,
        decorateWarn: (value) => `warn(${value})`,
        decorateTailscaleOff: (value) => `muted(${value})`,
      }),
    ).toEqual([
      { Item: "OS", Value: "macOS · node 22" },
      { Item: "Dashboard", Value: "http://127.0.0.1:18789/" },
      { Item: "Tailscale exposure", Value: "muted(off · box.tail.ts.net)" },
      { Item: "Channel", Value: baseStatusExpectedUpdateChannelLabel },
      { Item: "Git", Value: "main · tag v1.2.3" },
      { Item: "Update", Value: "available · custom update" },
      {
        Item: "Gateway",
        Value:
          "remote · wss://gateway.example.com (config) · ok(reachable 42ms) · auth token · gateway app 1.2.3",
      },
      { Item: "Gateway auth warning", Value: "warn(warn-text)" },
      { Item: "Gateway self", Value: "gateway app 1.2.3" },
      { Item: "Gateway service", Value: "LaunchAgent installed · loaded · running" },
      { Item: "Node service", Value: "node loaded · running (pid 42)" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });

  it("builds the shared gateway json payload from the overview surface", () => {
    expect(
      buildGatewayStatusJsonPayload({
        gatewayMode: "remote",
        remoteUrlMissing: false,
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
          message: "Gateway target: wss://gateway.example.com",
        },
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 42, error: null } as never,
        gatewayProbeAuthWarning: "warn-text",
        gatewaySelf: { host: "gateway", version: "1.2.3" },
      } as never),
    ).toEqual({
      mode: "remote",
      url: "wss://gateway.example.com",
      urlSource: "config",
      misconfigured: false,
      reachable: true,
      connectLatencyMs: 42,
      self: { host: "gateway", version: "1.2.3" },
      error: null,
      authWarning: "warn-text",
    });
  });
});
