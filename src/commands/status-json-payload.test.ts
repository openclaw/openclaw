// Status JSON payload tests cover update metadata, overview rows, and structured status output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildStatusJsonPayload } from "./status-json-payload.ts";

const mocks = vi.hoisted(() => ({
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "config",
    label: "stable",
  })),
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

describe("status-json-payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the shared status json payload with optional sections", () => {
    expect(
      buildStatusJsonPayload({
        summary: { ok: true },
        surface: {
          cfg: { update: { channel: "stable" }, gateway: {} },
          update: {
            root: "/tmp/openclaw",
            installKind: "git",
            packageManager: "npm",
            registry: { latestVersion: "1.2.3" },
            git: {
              ahead: 0,
              behind: 0,
              countsCached: true,
              stale: {
                reason: "fetch-failed",
                failedAtMs: 1000,
                detail: "network error",
                runId: "run-1",
              },
            },
          } as never,
          tailscaleMode: "serve",
          gatewayMode: "remote",
          remoteUrlMissing: false,
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayReachable: true,
          gatewayProbe: { connectLatencyMs: 42, error: null },
          gatewayProbeAuth: { token: "tok" },
          gatewaySelf: { host: "gateway" },
          gatewayProbeAuthWarning: "warn",
          gatewayService: { label: "LaunchAgent", installed: true, loadedText: "loaded" },
          nodeService: { label: "node", installed: true, loadedText: "loaded" },
        },
        osSummary: { platform: "linux" },
        memory: null,
        memoryPlugin: { enabled: true },
        agents: [{ id: "main" }],
        configDiagnostics: {
          path: "/tmp/openclaw.json",
          issues: [{ path: "gateway.port", message: "invalid" }],
        },
        secretDiagnostics: ["diag"],
        securityAudit: { summary: { critical: 1 } },
        health: { ok: true },
        usage: { providers: [] },
        lastHeartbeat: { status: "ok" },
        pluginCompatibility: [
          {
            pluginId: "legacy",
            code: "hook-only",
            severity: "info",
            message: "warn",
          },
        ],
      }),
    ).toEqual({
      ok: true,
      os: { platform: "linux" },
      update: {
        root: "/tmp/openclaw",
        installKind: "git",
        packageManager: "npm",
        registry: { latestVersion: "1.2.3" },
        git: {
          ahead: 0,
          behind: 0,
          countsCached: true,
          stale: {
            reason: "fetch-failed",
            failedAtMs: 1000,
            detail: "network error",
            runId: "run-1",
          },
        },
      },
      updateChannel: "stable",
      updateChannelSource: "config",
      memory: null,
      memoryPlugin: { enabled: true },
      gateway: {
        mode: "remote",
        url: "wss://gateway.example.com",
        urlSource: "config",
        misconfigured: false,
        reachable: true,
        connectLatencyMs: 42,
        self: { host: "gateway" },
        error: null,
        authWarning: "warn",
      },
      gatewayService: { label: "LaunchAgent", installed: true, loadedText: "loaded" },
      nodeService: { label: "node", installed: true, loadedText: "loaded" },
      agents: [{ id: "main" }],
      configDiagnostics: {
        path: "/tmp/openclaw.json",
        issues: [{ path: "gateway.port", message: "invalid" }],
      },
      secretDiagnostics: ["diag"],
      securityAudit: { summary: { critical: 1 } },
      health: { ok: true },
      usage: { providers: [] },
      lastHeartbeat: { status: "ok" },
      pluginCompatibility: {
        count: 1,
        warnings: [
          {
            pluginId: "legacy",
            code: "hook-only",
            severity: "info",
            message: "warn",
          },
        ],
      },
    });
  });
});
