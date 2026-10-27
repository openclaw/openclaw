import { describe, expect, it } from "vitest";
import { buildStatusOverviewSurfaceRows, buildStatusUpdateSurface } from "./status-all/format.js";
import {
  baseStatusExpectedUpdateChannelLabel,
  baseStatusOverviewSurface,
} from "./status.test-support.ts";
import { createMacosAppInstallOwner } from "./test-runtime-config-helpers.js";

describe("status-overview-surface", () => {
  it("shows the app owner and its update hint without offering a package update", () => {
    const update = buildStatusUpdateSurface({
      update: {
        root: "/Applications/OpenClaw.app/Contents/Resources/openclaw",
        installKind: "host",
        packageManager: "unknown",
        installOwner: createMacosAppInstallOwner(),
      },
    });

    expect(update).toMatchObject({
      updateLine: "Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway.",
      updateAvailable: false,
      gitLabel: null,
    });
  });
  it("builds overview rows from the shared surface bundle", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        tailscaleMode: "off",
        tailscaleHttpsUrl: null,
        prefixRows: [{ Item: "OS", Value: "macOS · node 22" }],
        suffixRows: [{ Item: "Secrets", Value: "none" }],
        agentsValue: "2 total",
        updateValue: "available · custom update",
        gatewayAuthWarningValue: "warn(warn-text)",
        includeDnsNameWhenOff: true,
        decorateOk: (value) => `ok(${value})`,
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
});
