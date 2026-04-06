import { describe, expect, it } from "vitest";
import { buildStatusScanResult } from "./status.scan-result.ts";
import { buildColdStartStatusSummary } from "./status.scan.bootstrap-shared.ts";

describe("buildStatusScanResult", () => {
  it("builds the full shared scan result shape", () => {
    expect(
      buildStatusScanResult({
        cfg: { gateway: {} },
        sourceConfig: { gateway: {} },
        secretDiagnostics: ["diag"],
        osSummary: {
          platform: "linux",
          arch: "x64",
          release: "6.8.0",
          label: "linux 6.8.0 (x64)",
        },
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        update: {
          root: "/tmp/openclaw",
          installKind: "package",
          packageManager: "npm",
        },
        gatewaySnapshot: {
          gatewayConnection: {
            url: "ws://127.0.0.1:18789",
            urlSource: "config",
            message: "Gateway target: ws://127.0.0.1:18789",
          },
          remoteUrlMissing: false,
          gatewayMode: "local",
          gatewayProbeAuth: { token: "tok" },
          gatewayProbeAuthWarning: "warn",
          gatewayProbe: {
            ok: true,
            url: "ws://127.0.0.1:18789",
            connectLatencyMs: 42,
            error: null,
            close: null,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          },
          gatewayReachable: true,
          gatewaySelf: { host: "gateway" },
        },
        channelIssues: [
          {
            channel: "discord",
            accountId: "default",
            kind: "runtime",
            message: "warn",
          },
        ],
        agentStatus: {
          defaultId: "main",
          totalSessions: 0,
          bootstrapPendingCount: 0,
          agents: [
            {
              id: "main",
              workspaceDir: null,
              bootstrapPending: false,
              sessionsPath: "/tmp/main.json",
              sessionsCount: 0,
              lastUpdatedAt: null,
              lastActiveAgeMs: null,
            },
          ],
        },
        channels: { rows: [], details: [] },
        summary: buildColdStartStatusSummary(),
        memory: { agentId: "main", backend: "builtin", provider: "sqlite" },
        memoryPlugin: { enabled: true, slot: "memory-core" },
        pluginCompatibility: [
          {
            pluginId: "legacy",
            code: "legacy-before-agent-start",
            severity: "warn",
            message: "warn",
          },
        ],
      }),
    ).toEqual({
      cfg: { gateway: {} },
      sourceConfig: { gateway: {} },
      secretDiagnostics: ["diag"],
      osSummary: {
        platform: "linux",
        arch: "x64",
        release: "6.8.0",
        label: "linux 6.8.0 (x64)",
      },
      tailscaleMode: "serve",
      tailscaleDns: "box.tail.ts.net",
      tailscaleHttpsUrl: "https://box.tail.ts.net",
      update: {
        root: "/tmp/openclaw",
        installKind: "package",
        packageManager: "npm",
      },
      gatewayConnection: {
        url: "ws://127.0.0.1:18789",
        urlSource: "config",
        message: "Gateway target: ws://127.0.0.1:18789",
      },
      remoteUrlMissing: false,
      gatewayMode: "local",
      gatewayProbeAuth: { token: "tok" },
      gatewayProbeAuthWarning: "warn",
      gatewayProbe: {
        ok: true,
        url: "ws://127.0.0.1:18789",
        connectLatencyMs: 42,
        error: null,
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      },
      gatewayReachable: true,
      gatewaySelf: { host: "gateway" },
      channelIssues: [
        {
          channel: "discord",
          accountId: "default",
          kind: "runtime",
          message: "warn",
        },
      ],
      agentStatus: {
        defaultId: "main",
        totalSessions: 0,
        bootstrapPendingCount: 0,
        agents: [
          {
            id: "main",
            workspaceDir: null,
            bootstrapPending: false,
            sessionsPath: "/tmp/main.json",
            sessionsCount: 0,
            lastUpdatedAt: null,
            lastActiveAgeMs: null,
          },
        ],
      },
      channels: { rows: [], details: [] },
      summary: buildColdStartStatusSummary(),
      memory: { agentId: "main", backend: "builtin", provider: "sqlite" },
      memoryPlugin: { enabled: true, slot: "memory-core" },
      pluginCompatibility: [
        {
          pluginId: "legacy",
          code: "legacy-before-agent-start",
          severity: "warn",
          message: "warn",
        },
      ],
    });
  });
});
