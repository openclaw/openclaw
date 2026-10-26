import { describe, expect, it } from "vitest";
import { baseStatusOverviewSurface, getStatusOverviewRowValue } from "../status.test-support.ts";
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
  gatewayReachable: false,
  gatewayProbe: null,
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

  it("builds local and fallback remote gateway summaries", () => {
    row("Gateway", {
      gatewayMode: "local",
      gatewayConnection: { url: "ws://127.0.0.1:18789" },
      gatewayProbe: { connectLatencyMs: 12 },
      gatewaySelf: { host: "gateway-host" },
    }).toBe("local · ws://127.0.0.1:18789 · reachable 12ms · auth token · gateway-host");
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
    expect(
      buildStatusUpdateSurface({
        updateConfigChannel: "stable",
        update: {
          ...baseStatusOverviewSurface.update,
          registry: { latestVersion: "9999.0.0" },
        },
      }),
    ).toMatchObject({
      updateLine: "git main · ↔ origin/main · behind 2 · npm update 9999.0.0",
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

  it("formats available addresses and missing MagicDNS with the backend state", () => {
    row("Tailscale exposure", {}).toBe("serve · box.tail.ts.net · https://box.tail.ts.net");
    row("Tailscale exposure", {
      tailscaleMode: "funnel",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      includeBackendStateWhenOn: true,
    }).toBe("funnel · unknown · magicdns unknown");
  });

  it("formats absent and failed service runtimes", () => {
    row("Gateway service", {
      gatewayService: { label: "LaunchAgent", installed: false, loadedText: "not loaded" },
    }).toBe("LaunchAgent not installed");
    row("Gateway service", {
      gatewayService: {
        label: "systemd",
        installed: true,
        loadedText: "not loaded",
        runtime: { status: "failed", pid: 42 },
      },
    }).toBe("systemd not loaded · failed (pid 42)");
  });

  const inspectionFailure = " (inspection failed: permission denied)";
  it.each`
    service                                                                                                              | expected
    ${{ installed: false }}                                                                                              | ${"LaunchAgent unknown" + inspectionFailure}
    ${{ installed: null }}                                                                                               | ${"LaunchAgent unknown" + inspectionFailure}
    ${{ managedByOpenClaw: true, runtimeShort: "running (pid 42)" }}                                                     | ${"LaunchAgent installed · unknown" + inspectionFailure + " · running (pid 42)"}
    ${{ managedByOpenClaw: false, loadedText: "running (externally managed)", runtime: { status: "running", pid: 42 } }} | ${"LaunchAgent running (externally managed)" + inspectionFailure + " · running (pid 42)"}
  `("keeps inspection errors visible: $expected", ({ service, expected }) => {
    row("Gateway service", {
      gatewayService: {
        label: "LaunchAgent",
        installed: true,
        loadedText: "unknown",
        ...service,
        loadState: { status: "unknown", detail: "permission denied" },
      },
    }).toBe(expected);
  });

  it("redacts credential-bearing Gateway URLs from text status", () => {
    const summary = getStatusOverviewRowValue("Gateway", {
      ...offlineGateway,
      gatewayMode: "remote",
      gatewayConnection: {
        url: "wss://user:password@gateway.example/ws?token=secret&key=api-key&X-Amz-Signature=signed",
        urlSource: "cli --url",
      },
      gatewayProbe: { error: "unreachable" },
      gatewaySelf: baseStatusOverviewSurface.gatewaySelf,
    });
    expect(summary).toContain("gateway.example/ws");
    expect(JSON.stringify({ summary })).not.toMatch(/password|secret|api-key|signed/);
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

  it("prefers node-only gateway values", () => {
    row("Gateway", {
      ...offlineGateway,
      nodeOnlyGateway: { gatewayValue: "node → remote.example:18789 · no local gateway" },
    }).toBe("node → remote.example:18789 · no local gateway");
  });

  it("inserts middle rows between the auth warning and gateway self", () => {
    const rows = buildStatusOverviewSurfaceRows({
      ...baseStatusOverviewSurface,
      middleRows: [{ Item: "Security", Value: "Run: openclaw security audit --deep" }],
      gatewayAuthWarningValue: "warning",
      agentsValue: "2 total",
    });
    const index = rows.findIndex(({ Item }) => Item === "Security");
    expect(rows.slice(index - 1, index + 2)).toEqual([
      { Item: "Gateway auth warning", Value: "warning" },
      { Item: "Security", Value: "Run: openclaw security audit --deep" },
      { Item: "Gateway self", Value: "gateway app 1.2.3" },
    ]);
  });
});
