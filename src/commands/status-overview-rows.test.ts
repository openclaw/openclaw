// Status overview row tests cover status-all overview values, update metadata, and display rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import * as memoryStatus from "../memory-host-sdk/status.js";
import { VERSION } from "../version.js";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";
import {
  baseStatusOverviewSurface,
  createStatusCommandOverviewRowsParams,
} from "./status.test-support.ts";

beforeEach(() => {
  vi.spyOn(theme, "success").mockImplementation((value) => `ok(${String(value)})`);
  vi.spyOn(theme, "warn").mockImplementation((value) => `warn(${String(value)})`);
  vi.spyOn(theme, "muted").mockImplementation((value) => `muted(${String(value)})`);
  vi.spyOn(memoryStatus, "resolveMemoryVectorState").mockReturnValue({
    state: "ready",
    tone: "ok",
  });
  vi.spyOn(memoryStatus, "resolveMemoryFtsState").mockReturnValue({ state: "ready", tone: "warn" });
  vi.spyOn(memoryStatus, "resolveMemoryCacheSummary").mockReturnValue({
    text: "cache warm",
    tone: "muted",
  });
});
afterEach(() => vi.restoreAllMocks());

function findRowValue(rows: Array<{ Item: string; Value: string }>, item: string) {
  return rows.find((row) => row.Item === item)?.Value;
}

describe("status-overview-rows", () => {
  it("shows the latest offsite attempt beside a newer local backup", () => {
    vi.spyOn(Date, "now").mockReturnValue(3_600_000);
    const rows = buildStatusCommandOverviewRows({
      ...createStatusCommandOverviewRowsParams(),
      backupFreshness: {
        latest: {
          id: "local",
          createdAt: 3_000_000,
          archivePath: "/backup/local",
          kind: "git",
          status: "ok",
        },
        latestOffsite: {
          id: "remote",
          createdAt: 1,
          archivePath: "",
          kind: "archive",
          status: "failed",
          target: "offsite",
        },
      },
    });
    expect(findRowValue(rows, "Backups")).toContain("last ok");
    expect(findRowValue(rows, "Offsite backup")).toContain("offsite: last attempt failed");
  });

  it.each(["default"])("preserves service inspection failures in %s output", (mode) => {
    const params = createStatusCommandOverviewRowsParams();
    const service = {
      label: "LaunchAgent",
      installed: false,
      loadedText: "unknown",
      loadState: { status: "unknown" as const, detail: "permission denied token=fixture" },
    };
    const surface = {
      ...params.surface,
      gatewayService: service,
      nodeService: {
        ...service,
        loadedText: "not loaded",
        loadState: { status: "not-loaded" as const },
        runtime: { status: "unknown", detail: "system domain permission denied token=fixture" },
      },
    };
    const rows =
      mode === "default"
        ? buildStatusCommandOverviewRows({ ...params, surface })
        : buildStatusAllOverviewRows({
            ...params,
            surface,
            configPath: "/tmp/openclaw.json",
            secretDiagnosticsCount: 0,
          });

    expect(findRowValue(rows, "Gateway service")).toBe(
      "LaunchAgent unknown (inspection failed: permission denied token=***)",
    );
    expect(findRowValue(rows, "Node service")).toBe(
      "LaunchAgent not loaded (inspection failed: system domain permission denied token=***) · unknown",
    );
  });

  it.each<{
    label: string;
    doNotTrack?: string;
    noAutoUpdate?: string;
    checkOnStart?: boolean;
    expected: string;
  }>([
    {
      label: "explicitly enabled",
      expected: "ok(enabled · anonymous feature stats)",
    },
    {
      label: "blocked by a trimmed DO_NOT_TRACK value",
      doNotTrack: " TRUE ",
      expected: "muted(disabled (DO_NOT_TRACK))",
    },
  ])(
    "shows telemetry state when $label",
    ({ doNotTrack, noAutoUpdate, checkOnStart = true, expected }) => {
      const params = createStatusCommandOverviewRowsParams();
      const rows = buildStatusCommandOverviewRows({
        ...params,
        env: {
          ...params.env,
          DO_NOT_TRACK: doNotTrack,
          OPENCLAW_NO_AUTO_UPDATE: noAutoUpdate,
        },
        surface: {
          ...params.surface,
          cfg: { ...params.surface.cfg, telemetry: { enabled: true }, update: { checkOnStart } },
        },
      });

      expect(findRowValue(rows, "Telemetry")).toBe(expected);
    },
  );

  it("reports automatic update checks as disabled for Nix-managed installations", () => {
    const params = createStatusCommandOverviewRowsParams();
    const rows = buildStatusCommandOverviewRows({
      ...params,
      env: { ...params.env, OPENCLAW_NIX_MODE: "1" },
      surface: {
        ...params.surface,
        cfg: { ...params.surface.cfg, telemetry: { enabled: true } },
      },
    });

    expect(findRowValue(rows, "Telemetry")).toBe("muted(disabled · update checks off)");
  });

  it("marks skipped memory inspection as not checked in fast status output", () => {
    const rows = buildStatusCommandOverviewRows(
      createStatusCommandOverviewRowsParams({
        memory: null,
        memoryPlugin: { enabled: true, slot: "memory-lancedb-pro" },
      }),
    );

    expect(findRowValue(rows, "Memory")).toBe(
      "muted(enabled (plugin memory-lancedb-pro) · not checked)",
    );
  });

  it("shows managed host desktop coordinates", () => {
    const params = createStatusCommandOverviewRowsParams();
    const rows = buildStatusCommandOverviewRows({
      ...params,
      summary: {
        ...params.summary,
        hostDesktop: {
          enabled: true,
          state: "managed",
          managedState: "running",
          display: 99,
          port: 46_001,
          security: "VncAuth",
        },
      },
    });

    expect(findRowValue(rows, "Host desktop")).toBe(
      "managed · running · display :99 · 127.0.0.1:46001 · security VncAuth",
    );
  });

  it("builds status-all overview rows from the shared surface", () => {
    const summary = createStatusCommandOverviewRowsParams().summary;
    const rows = buildStatusAllOverviewRows({
      automations: { ok: true, value: { enabled: true, jobs: 0, nextWakeAtMs: null } },
      surface: {
        ...baseStatusOverviewSurface,
        tailscaleMode: "off",
        tailscaleHttpsUrl: null,
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
      },
      summary: {
        ...summary,
        secretEgressProxy: {
          state: "degraded",
          caExpiresAt: "2036-09-01T00:00:00.000Z",
          failedCertificates: 1,
          message: "Check OpenSSL, then retry the request.",
        },
        degradedSecretOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            paths: ["tts.providers.elevenlabs.apiKey"],
            reason: "secret reference was not found",
          },
        ],
        degradedPlugins: [
          {
            pluginId: "discord",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "unreadable-package-json",
              detail: "permission denied",
            },
          },
        ],
      },
      osLabel: "macOS",
      configPath: "/tmp/openclaw.json",
      secretDiagnosticsCount: 2,
      updateRows: [{ Item: "Update restart", Value: "restart pending health verification" }],
      agentStatus: {
        bootstrapPendingCount: 1,
        totalSessions: 2,
        agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
      },
    });

    expect(findRowValue(rows, "Version")).toBe(VERSION);
    expect(findRowValue(rows, "OS")).toBe("macOS");
    expect(findRowValue(rows, "Config")).toBe("/tmp/openclaw.json");
    expect(findRowValue(rows, "Gateway self")).toBe("gateway app 1.2.3");
    expect(findRowValue(rows, "Update")).toContain("behind 2");
    expect(findRowValue(rows, "Update restart")).toBe("restart pending health verification");
    expect(findRowValue(rows, "Security")).toBe("Run: openclaw security audit --deep");
    expect(findRowValue(rows, "Secret egress proxy")).toBe(
      "Check OpenSSL, then retry the request.",
    );
    expect(findRowValue(rows, "Degraded secrets")).toBe("1 degraded · capability:tts");
    expect(findRowValue(rows, "Degraded plugins")).toBe("1 configured-unavailable · discord");
    expect(findRowValue(rows, "Secrets")).toBe("2 diagnostics");
  });

  it.each([{}])("uses unknown only when Gateway self metadata is absent (%j)", (gatewaySelf) => {
    const params = createStatusCommandOverviewRowsParams();
    const surface = { ...params.surface, gatewaySelf };
    const rows = buildStatusAllOverviewRows({
      ...params,
      surface,
      configPath: "/tmp/openclaw.json",
      secretDiagnosticsCount: 0,
    });

    expect(findRowValue(rows, "Gateway self")).toBe("unknown");
    expect(
      findRowValue(buildStatusCommandOverviewRows({ ...params, surface }), "Gateway self"),
    ).toBeUndefined();
  });
});
