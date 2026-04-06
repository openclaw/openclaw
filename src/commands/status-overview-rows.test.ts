import { describe, expect, it } from "vitest";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";

describe("status-overview-rows", () => {
  it("builds command overview rows from the shared surface", () => {
    expect(
      buildStatusCommandOverviewRows({
        opts: { deep: true },
        surface: {
          cfg: { update: { channel: "stable" }, gateway: { bind: "loopback" } },
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
            registry: { latestVersion: "2026.4.9" },
          } as never,
          tailscaleMode: "serve",
          tailscaleDns: "box.tail.ts.net",
          tailscaleHttpsUrl: "https://box.tail.ts.net",
          gatewayMode: "remote",
          remoteUrlMissing: false,
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayReachable: true,
          gatewayProbe: { connectLatencyMs: 42, error: null },
          gatewayProbeAuth: { token: "tok" },
          gatewayProbeAuthWarning: "warn-text",
          gatewaySelf: { host: "gateway", version: "1.2.3" },
          gatewayService: {
            label: "LaunchAgent",
            installed: true,
            managedByOpenClaw: true,
            loadedText: "loaded",
            runtimeShort: "running",
          },
          nodeService: {
            label: "node",
            installed: true,
            loadedText: "loaded",
            runtime: { status: "running", pid: 42 },
          },
          nodeOnlyGateway: null,
        },
        osLabel: "macOS",
        summary: {
          tasks: { total: 3, active: 1, failures: 0, byStatus: { queued: 1, running: 1 } },
          taskAudit: { errors: 1, warnings: 0 },
          heartbeat: {
            agents: [{ agentId: "main", enabled: true, everyMs: 60_000, every: "1m" }],
          },
          queuedSystemEvents: ["one", "two"],
          sessions: {
            count: 2,
            paths: ["store.json"],
            defaults: { model: "gpt-5.4", contextTokens: 12_000 },
          },
        },
        health: { durationMs: 42 },
        lastHeartbeat: {
          ts: Date.now() - 30_000,
          status: "ok",
          channel: "discord",
          accountId: "acct",
        },
        agentStatus: {
          defaultId: "main",
          bootstrapPendingCount: 1,
          totalSessions: 2,
          agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
        },
        memory: { files: 1, chunks: 2, vector: {}, fts: {}, cache: {} },
        memoryPlugin: { enabled: true, slot: "memory" },
        pluginCompatibility: [{ pluginId: "a", severity: "warn", message: "legacy" }],
        ok: (value) => `ok(${value})`,
        warn: (value) => `warn(${value})`,
        muted: (value) => `muted(${value})`,
        formatTimeAgo: (value) => `${value}ms`,
        formatKTokens: (value) => `${Math.round(value / 1000)}k`,
        resolveMemoryVectorState: () => ({ state: "ready", tone: "ok" }),
        resolveMemoryFtsState: () => ({ state: "ready", tone: "warn" }),
        resolveMemoryCacheSummary: () => ({ text: "cache warm", tone: "muted" }),
        updateValue: "available · custom update",
      }),
    ).toEqual(
      expect.arrayContaining([
        { Item: "OS", Value: `macOS · node ${process.versions.node}` },
        {
          Item: "Memory",
          Value:
            "1 files · 2 chunks · plugin memory · ok(vector ready) · warn(fts ready) · muted(cache warm)",
        },
        { Item: "Plugin compatibility", Value: "warn(1 notice · 1 plugin)" },
        { Item: "Sessions", Value: "2 active · default gpt-5.4 (12k ctx) · store.json" },
      ]),
    );
  });

  it("builds status-all overview rows from the shared surface", () => {
    expect(
      buildStatusAllOverviewRows({
        surface: {
          cfg: { update: { channel: "stable" }, gateway: { bind: "loopback" } },
          update: {
            installKind: "git",
            git: { branch: "main", tag: "v1.2.3", upstream: "origin/main" },
          } as never,
          tailscaleMode: "off",
          tailscaleDns: "box.tail.ts.net",
          tailscaleHttpsUrl: null,
          gatewayMode: "remote",
          remoteUrlMissing: false,
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayReachable: true,
          gatewayProbe: { connectLatencyMs: 42, error: null },
          gatewayProbeAuth: { token: "tok" },
          gatewayProbeAuthWarning: "warn-text",
          gatewaySelf: { host: "gateway", version: "1.2.3" },
          gatewayService: {
            label: "LaunchAgent",
            installed: true,
            managedByOpenClaw: true,
            loadedText: "loaded",
            runtimeShort: "running",
          },
          nodeService: {
            label: "node",
            installed: true,
            loadedText: "loaded",
            runtime: { status: "running", pid: 42 },
          },
          nodeOnlyGateway: null,
        },
        osLabel: "macOS",
        configPath: "/tmp/openclaw.json",
        secretDiagnosticsCount: 2,
        agentStatus: {
          bootstrapPendingCount: 1,
          totalSessions: 2,
          agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
        },
        tailscaleBackendState: "Running",
      }),
    ).toEqual(
      expect.arrayContaining([
        { Item: "Version", Value: expect.any(String) },
        { Item: "OS", Value: "macOS" },
        { Item: "Config", Value: "/tmp/openclaw.json" },
        { Item: "Security", Value: "Run: openclaw security audit --deep" },
        { Item: "Secrets", Value: "2 diagnostics" },
      ]),
    );
  });
});
