import { describe, expect, it } from "vitest";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";
import {
  baseStatusOverviewSurface,
  createStatusCommandOverviewRowsParams,
} from "./status.test-support.ts";

describe("status-overview-rows", () => {
  it("builds command overview rows from the shared surface", () => {
    expect(
      buildStatusCommandOverviewRows(
        createStatusCommandOverviewRowsParams({
          summary: {
            ...createStatusCommandOverviewRowsParams().summary,
            a2a: {
              state: "waiting_external",
              tasks: {
                total: 3,
                active: 1,
                failed: 1,
                waitingExternal: 1,
                delayed: 0,
                latestFailed: {
                  agentId: "main",
                  sessionKey: "agent:main:main",
                  taskId: "a2a-1",
                  executionStatus: "failed",
                  deliveryStatus: "failed",
                  updatedAt: 1,
                  errorMessage: "broker unavailable",
                },
              },
              issues: {
                brokerUnreachable: 1,
                reconcileFailed: 0,
                deliveryFailed: 1,
                cancelNotAttempted: 0,
                sessionAbortFailed: 0,
              },
              broker: {
                pluginEnabled: true,
                adapterEnabled: true,
                baseUrlPresent: true,
                edgeSecretPresent: true,
                methodScopesOk: true,
              },
            },
          } as never,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { Item: "OS", Value: `macOS · node ${process.versions.node}` },
        {
          Item: "A2A",
          Value:
            "warn(waiting external) · broker on · 1 active · 1 waiting external · warn(1 failed) · latest broker unavailable",
        },
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


  it("prefers contributor-owned A2A rows over the built-in fallback", () => {
    const rows = buildStatusCommandOverviewRows({
      opts: { deep: false },
      surface: {
        cfg: { update: { channel: "stable" }, gateway: { bind: "loopback" } },
        update: { installKind: "git", git: { branch: "main", tag: "v1.2.3", upstream: "origin/main" } } as never,
        tailscaleMode: "serve",
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        gatewayMode: "remote",
        remoteUrlMissing: false,
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
        gatewayReachable: true,
        gatewayProbe: { connectLatencyMs: 42, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewayProbeAuthWarning: null,
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayService: { label: "LaunchAgent", installed: true, managedByOpenClaw: true, loadedText: "loaded", runtimeShort: "running" },
        nodeService: { label: "node", installed: true, loadedText: "loaded", runtime: { status: "running", pid: 42 } },
        nodeOnlyGateway: null,
      },
      osLabel: "macOS",
      summary: {
        contributors: [
          {
            id: "a2a",
            label: "A2A",
            state: "warn",
            summary: "plugin-owned broker status",
            details: ["1 active", "waiting on broker"],
          },
          {
            id: "diag",
            label: "Diagnostics",
            state: "info",
            summary: "extra plugin signal",
          },
        ],
        a2a: {
          state: "failed",
          tasks: {
            total: 3,
            active: 0,
            failed: 2,
            waitingExternal: 0,
            delayed: 0,
            latestFailed: null,
          },
          issues: {
            brokerUnreachable: 2,
            reconcileFailed: 0,
            deliveryFailed: 1,
            cancelNotAttempted: 0,
            sessionAbortFailed: 0,
          },
          broker: {
            pluginEnabled: true,
            adapterEnabled: true,
            baseUrlPresent: true,
            edgeSecretPresent: true,
            methodScopesOk: true,
          },
        },
        tasks: { total: 1, active: 0, failures: 0, byStatus: { queued: 0, running: 0 } },
        taskAudit: { errors: 0, warnings: 0 },
        heartbeat: { agents: [{ agentId: "main", enabled: true, everyMs: 60_000, every: "1m" }] },
        queuedSystemEvents: [],
        sessions: {
          count: 1,
          paths: ["store.json"],
          defaults: { model: "gpt-5.4", contextTokens: 12_000 },
        },
      },
      health: { durationMs: 42 },
      lastHeartbeat: null,
      agentStatus: {
        defaultId: "main",
        bootstrapPendingCount: 0,
        totalSessions: 1,
        agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
      },
      memory: null,
      memoryPlugin: { enabled: false, reason: "off" },
      pluginCompatibility: [],
      ok: (value: string) => `ok(${value})`,
      warn: (value: string) => `warn(${value})`,
      muted: (value: string) => `muted(${value})`,
      formatTimeAgo: (value: number) => `${value}ms`,
      formatKTokens: (value: number) => `${Math.round(value / 1000)}k`,
      resolveMemoryVectorState: () => ({ state: "ready", tone: "ok" }),
      resolveMemoryFtsState: () => ({ state: "ready", tone: "warn" }),
      resolveMemoryCacheSummary: () => ({ text: "cache warm", tone: "muted" }),
    } as unknown as Parameters<typeof buildStatusCommandOverviewRows>[0]);

    expect(rows).toContainEqual({
      Item: "A2A",
      Value: "warn(plugin-owned broker status) · 1 active · waiting on broker",
    });
    expect(rows).toContainEqual({
      Item: "Diagnostics",
      Value: "muted(extra plugin signal)",
    });
    expect(
      rows.filter((row) => row.Item === "A2A" && row.Value.includes("broker on")),
    ).toHaveLength(0);
  });

  it("builds status-all overview rows from the shared surface", () => {
    expect(
      buildStatusAllOverviewRows({
        surface: {
          ...baseStatusOverviewSurface,
          tailscaleMode: "off",
          tailscaleHttpsUrl: null,
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
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
