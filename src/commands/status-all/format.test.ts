import { describe, expect, it } from "vitest";
import {
  baseStatusExpectedUpdateChannelLabel,
  baseStatusOverviewSurface,
  getStatusOverviewRowValue,
} from "../status.test-support.ts";
import {
  buildStatusOverviewSurfaceRows,
  buildStatusUpdateSurface,
  redactStatusSecrets,
} from "./format.js";

function row(item: string, overrides: Parameters<typeof getStatusOverviewRowValue>[1]) {
  return expect(getStatusOverviewRowValue(item, overrides));
}

const offlineGateway = {
  gatewayMode: "local" as const,
  gatewayConnection: { url: "ws://127.0.0.1:18789" },
  remoteUrlMissing: false,
  gatewayReachable: false,
  gatewayProbe: null,
  gatewayProbeAuth: null,
  gatewaySelf: null,
};

describe("status-all format", () => {
  it("masks complete credential values before terminal cleanup", () => {
    for (const [input, expected] of [
      ["token=synthetic-secret next", "token=*** next"],
      ['password="synthetic horse battery" next', "password=*** next"],
      ['{"token": "synthetic-secret", "safe": true}', '{"token": ***, "safe": true}'],
      ["password=synthetic,secret next", "password=*** next"],
      ["token=Bearer ~synthetic+secret/== next", "token=*** next"],
      ["Authorization: Bearer ~synthetic+secret/== next", "Authorization: Bearer *** next"],
      ['secret="synthetic\nsecret" next', "secret=*** next"],
      ["token=synthetic\u001b[31msecret next", "token=*** next"],
      ["ordinary status message", "ordinary status message"],
    ] as const) {
      expect(redactStatusSecrets(input)).toBe(expected);
    }
  });

  it("formats gateway self summary consistently", () => {
    row("Gateway self", {
      gatewaySelf: { host: "gateway-host", ip: "100.64.0.1", version: "1.2.3", platform: "linux" },
    }).toBe("gateway-host (100.64.0.1) app 1.2.3 linux");
    row("Gateway self", { gatewaySelf: null }).toBe(undefined);
  });

  it("builds gateway summary parts for fallback remote targets", () => {
    row("Gateway", {
      ...offlineGateway,
      gatewayMode: "remote",
      remoteUrlMissing: true,
      gatewayConnection: {
        url: "ws://127.0.0.1:18789",
        urlSource: "missing gateway.remote.url (fallback local)",
      },
      gatewayProbeAuth: { token: "tok" },
    }).toBe(
      "remote (remote.url missing) · fallback ws://127.0.0.1:18789 (missing gateway.remote.url (fallback local)) · misconfigured (remote.url missing)",
    );
  });

  it("formats dashboard values consistently", () => {
    row("Dashboard", {
      advertisedControlUiLinks: { httpUrl: "https://openclaw.local", wsUrl: "" },
    }).toBe("https://openclaw.local");
    row("Dashboard", { advertisedControlUiLinks: { httpUrl: "", wsUrl: "" } }).toBe("disabled");
  });

  it("builds shared update surface values", () => {
    const newerRegistryVersion = "9999.0.0";

    expect(
      buildStatusUpdateSurface({
        updateConfigChannel: "stable",
        update: {
          ...baseStatusOverviewSurface.update,
          registry: { latestVersion: newerRegistryVersion },
        },
      }),
    ).toEqual({
      channelLabel: baseStatusExpectedUpdateChannelLabel,
      gitLabel: "main · tag v1.2.3",
      updateLine: `git main · ↔ origin/main · behind 2 · npm update ${newerRegistryVersion}`,
      updateAvailable: true,
    });
  });

  it.each([
    [
      { bind: "loopback", controlUi: { enabled: true, basePath: "/ui" } },
      "http://127.0.0.1:18789/ui/",
    ],
    [{ bind: "loopback", tls: { enabled: true } }, "https://127.0.0.1:18789/"],
    [{ controlUi: { enabled: false } }, "disabled"],
  ] as const)("resolves dashboard %j to %s", (gateway, expected) => {
    row("Dashboard", { cfg: { gateway } }).toBe(expected);
  });

  it("formats tailscale values for terse and detailed views", () => {
    row("Tailscale exposure", {}).toBe("serve · box.tail.ts.net · https://box.tail.ts.net");
    row("Tailscale exposure", {
      tailscaleMode: "funnel",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      includeBackendStateWhenOn: true,
    }).toBe("funnel · unknown · magicdns unknown");
    row("Tailscale exposure", {
      tailscaleMode: "off",
      includeDnsNameWhenOff: true,
    }).toBe("off · box.tail.ts.net");
  });

  it("formats a failed service runtime", () => {
    row("Gateway service", {
      gatewayService: {
        label: "systemd",
        installed: true,
        loadedText: "not loaded",
        runtime: { status: "failed", pid: 42 },
      },
    }).toBe("systemd not loaded · failed (pid 42)");
  });

  it.each([
    {
      installed: false,
      loadedText: "unknown",
      expected: "LaunchAgent unknown (inspection failed: permission denied)",
    },
    {
      installed: null,
      loadedText: "unknown",
      expected: "LaunchAgent unknown (inspection failed: permission denied)",
    },
    {
      installed: true,
      managedByOpenClaw: true,
      loadedText: "unknown",
      runtimeShort: "running (pid 42)",
      expected:
        "LaunchAgent installed · unknown (inspection failed: permission denied) · running (pid 42)",
    },
    {
      installed: true,
      managedByOpenClaw: false,
      loadedText: "running (externally managed)",
      runtime: { status: "running", pid: 42 },
      expected:
        "LaunchAgent running (externally managed) (inspection failed: permission denied) · running (pid 42)",
    },
  ])("keeps inspection errors visible: $expected", ({ expected, ...service }) => {
    row("Gateway service", {
      gatewayService: {
        ...service,
        label: "LaunchAgent",
        loadState: { status: "unknown", detail: "permission denied" },
      },
    }).toBe(expected);
  });

  it("redacts credential-bearing Gateway URLs from text status", () => {
    const gatewayConnection = {
      url: "wss://user:password@gateway.example/ws?token=secret&key=api-key&X-Amz-Signature=signed",
      urlSource: "cli --url",
    };

    const params = {
      ...offlineGateway,
      gatewayMode: "remote" as const,
      gatewayConnection,
      gatewayProbe: { error: "unreachable" },
      gatewaySelf: baseStatusOverviewSurface.gatewaySelf,
    } as const;
    const summary = getStatusOverviewRowValue("Gateway", params);
    const output = JSON.stringify({ summary });

    expect(summary).toContain("gateway.example/ws");
    expect(output).not.toMatch(/password|secret|api-key|signed/);
  });

  it("reports startup phase without an unreachable error in text", () => {
    const params = {
      ...offlineGateway,
      gatewayProbe: { startupPhase: "plugins", error: null },
    };
    expect(getStatusOverviewRowValue("Gateway", params)).toContain(
      "still starting (phase plugins)",
    );
    expect(getStatusOverviewRowValue("Gateway", params)).not.toContain("unreachable");
  });

  it("prefers node-only gateway values when present", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        agentsValue: "2 total",
        ...offlineGateway,
        cfg: { gateway: { controlUi: { enabled: false } } },
        gatewayService: { label: "LaunchAgent", installed: false, loadedText: "not loaded" },
        nodeService: {
          label: "node",
          installed: true,
          loadedText: "loaded",
          runtimeShort: "running",
        },
        nodeOnlyGateway: { gatewayValue: "node → remote.example:18789 · no local gateway" },
      })
        .filter(({ Item }) =>
          ["Dashboard", "Gateway", "Gateway self", "Gateway service", "Node service"].includes(
            Item,
          ),
        )
        .map(({ Item, Value }) => [Item, Value]),
    ).toEqual([
      ["Dashboard", "disabled"],
      ["Gateway", "node → remote.example:18789 · no local gateway"],
      ["Gateway service", "LaunchAgent not installed"],
      ["Node service", "node loaded · running"],
    ]);
  });

  it("builds overview rows with shared ordering", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        ...baseStatusOverviewSurface,
        prefixRows: [{ Item: "Version", Value: "1.0.0" }],
        advertisedControlUiLinks: { httpUrl: "https://openclaw.local", wsUrl: "" },
        gatewayMode: "local",
        gatewayConnection: { url: "ws://127.0.0.1:18789" },
        gatewayProbe: { connectLatencyMs: 12 },
        gatewaySelf: { host: "gateway-host" },
        gatewayService: { label: "launchd", installed: true, loadedText: "loaded" },
        nodeService: { label: "node", installed: true, loadedText: "loaded" },
        updateValue: "up to date",
        gatewayAuthWarningValue: "warning",
        middleRows: [{ Item: "Security", Value: "Run: openclaw security audit --deep" }],
        agentsValue: "2 total",
        suffixRows: [{ Item: "Secrets", Value: "none" }],
      }).map(({ Item, Value }) => [Item, Value]),
    ).toEqual([
      ["Version", "1.0.0"],
      ["Dashboard", "https://openclaw.local"],
      ["Tailscale exposure", "serve · box.tail.ts.net · https://box.tail.ts.net"],
      ["Channel", baseStatusExpectedUpdateChannelLabel],
      ["Git", "main · tag v1.2.3"],
      ["Update", "up to date"],
      ["Gateway", "local · ws://127.0.0.1:18789 · reachable 12ms · auth token · gateway-host"],
      ["Gateway auth warning", "warning"],
      ["Security", "Run: openclaw security audit --deep"],
      ["Gateway self", "gateway-host"],
      ["Gateway service", "launchd loaded"],
      ["Node service", "node loaded"],
      ["Agents", "2 total"],
      ["Secrets", "none"],
    ]);
  });
});
