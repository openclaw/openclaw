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
