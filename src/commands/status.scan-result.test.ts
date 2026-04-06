import { describe, expect, it } from "vitest";
import { buildStatusScanResult } from "./status.scan-result.ts";

describe("buildStatusScanResult", () => {
  it("builds the full shared scan result shape", () => {
    expect(
      buildStatusScanResult({
        cfg: { gateway: {} },
        sourceConfig: { gateway: {} },
        secretDiagnostics: ["diag"],
        osSummary: { platform: "linux", label: "linux" },
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        update: { installKind: "npm", git: null },
        gatewaySnapshot: {
          gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
          remoteUrlMissing: false,
          gatewayMode: "local",
          gatewayProbeAuth: { token: "tok" },
          gatewayProbeAuthWarning: "warn",
          gatewayProbe: { connectLatencyMs: 42, error: null },
          gatewayReachable: true,
          gatewaySelf: { host: "gateway" },
        },
        channelIssues: [{ channel: "discord", accountId: "default", message: "warn" }],
        agentStatus: { agents: [{ id: "main" }], defaultId: "main" },
        channels: { rows: [], details: [] },
        summary: { ok: true },
        memory: { agentId: "main" },
        memoryPlugin: { enabled: true, slot: "memory-core" },
        pluginCompatibility: [{ pluginId: "legacy", message: "warn" }],
      }),
    ).toEqual({
      cfg: { gateway: {} },
      sourceConfig: { gateway: {} },
      secretDiagnostics: ["diag"],
      osSummary: { platform: "linux", label: "linux" },
      tailscaleMode: "serve",
      tailscaleDns: "box.tail.ts.net",
      tailscaleHttpsUrl: "https://box.tail.ts.net",
      update: { installKind: "npm", git: null },
      gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
      remoteUrlMissing: false,
      gatewayMode: "local",
      gatewayProbeAuth: { token: "tok" },
      gatewayProbeAuthWarning: "warn",
      gatewayProbe: { connectLatencyMs: 42, error: null },
      gatewayReachable: true,
      gatewaySelf: { host: "gateway" },
      channelIssues: [{ channel: "discord", accountId: "default", message: "warn" }],
      agentStatus: { agents: [{ id: "main" }], defaultId: "main" },
      channels: { rows: [], details: [] },
      summary: { ok: true },
      memory: { agentId: "main" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      pluginCompatibility: [{ pluginId: "legacy", message: "warn" }],
    });
  });
});
