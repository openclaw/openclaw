import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import * as memoryStatus from "../memory-host-sdk/status.js";
import { VERSION } from "../version.js";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";
import { createStatusCommandOverviewRowsParams } from "./status.test-support.ts";

let params: ReturnType<typeof createStatusCommandOverviewRowsParams>;
beforeEach(() => {
  params = createStatusCommandOverviewRowsParams();
  params.surface = { ...params.surface };
  params.summary = { ...params.summary };
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

function backup(createdAt: number, kind: "git" | "archive", status: "ok" | "failed") {
  return { id: "fixture", archivePath: "", createdAt, kind, status };
}

it("keeps default status concise and reports configured family choices without secrets", () => {
  expect(
    findRowValue(buildStatusCommandOverviewRows(params), "Database engines (configured)"),
  ).toBeUndefined();
  const all = buildStatusAllOverviewRows({
    surface: params.surface,
    summary: params.summary,
    osLabel: params.osLabel,
    configPath: "/fixture/openclaw.json",
    secretDiagnosticsCount: 0,
    agentStatus: params.agentStatus,
  });
  expect(findRowValue(all, "Database engines (configured)")).toContain(
    "state: default=sqlite, override=inherit, effective=sqlite",
  );
  params.surface = {
    ...params.surface,
    cfg: {
      ...params.surface.cfg,
      database: {
        families: { workboard: { engine: "postgres" } },
        postgres: { connection: "postgres://fixture:secret@host/database" },
      },
    },
  };
  const value = findRowValue(
    buildStatusCommandOverviewRows(params),
    "Database engines (configured)",
  );
  expect(value).toContain("state: default=sqlite, override=inherit, effective=sqlite");
  expect(value).toContain("workboard: default=sqlite, override=postgres, effective=postgres");
  expect(value).toContain("quarantine: default=sqlite, override=fixed local, effective=sqlite");
  expect(value).not.toContain("secret");
  expect(value).not.toContain("experimental");
});

it("shows the latest offsite attempt beside a newer local backup", () => {
  vi.spyOn(Date, "now").mockReturnValue(3_600_000);
  params.backupFreshness = {
    latest: backup(3_000_000, "git", "ok"),
    latestOffsite: { ...backup(1, "archive", "failed"), target: "offsite" },
  };
  const rows = buildStatusCommandOverviewRows(params);
  expect(findRowValue(rows, "Backups")).toContain("last ok");
  expect(findRowValue(rows, "Offsite backup")).toContain("offsite: last attempt failed");
});

it("preserves service inspection failures in default output", () => {
  const service = {
    label: "LaunchAgent",
    installed: false,
    loadedText: "unknown",
    loadState: { status: "unknown" as const, detail: "permission denied token=fixture" },
  };
  params.surface.gatewayService = service;
  params.surface.nodeService = {
    ...service,
    loadedText: "not loaded",
    loadState: { status: "not-loaded" as const },
    runtime: { status: "unknown", detail: "system domain permission denied token=fixture" },
  };
  const rows = buildStatusCommandOverviewRows(params);

  expect(findRowValue(rows, "Gateway service")).toBe(
    "LaunchAgent unknown (inspection failed: permission denied token=***)",
  );
  expect(findRowValue(rows, "Node service")).toBe(
    "LaunchAgent not loaded (inspection failed: system domain permission denied token=***) · unknown",
  );
});

it.each([
  [{}, "ok(enabled · anonymous feature stats)"],
  [{ DO_NOT_TRACK: " TRUE " }, "muted(disabled (DO_NOT_TRACK))"],
  [{ OPENCLAW_NIX_MODE: "1" }, "muted(disabled · update checks off)"],
] as const)("shows telemetry state for %j", (env, expected) => {
  params.env = { ...params.env, ...env };
  params.surface.cfg = {
    ...params.surface.cfg,
    telemetry: { enabled: true },
    update: { checkOnStart: true },
  };
  const rows = buildStatusCommandOverviewRows(params);

  expect(findRowValue(rows, "Telemetry")).toBe(expected);
});

it("marks skipped memory inspection as not checked in fast status output", () => {
  params.memory = null;
  params.memoryPlugin = { enabled: true, slot: "memory-lancedb-pro" };
  const rows = buildStatusCommandOverviewRows(params);

  expect(findRowValue(rows, "Memory")).toBe(
    "muted(enabled (plugin memory-lancedb-pro) · not checked)",
  );
});

it("shows managed host desktop coordinates", () => {
  params.summary.hostDesktop = {
    enabled: true,
    state: "managed",
    managedState: "running",
    display: 99,
    port: 46_001,
    security: "VncAuth",
  };
  const rows = buildStatusCommandOverviewRows(params);

  expect(findRowValue(rows, "Host desktop")).toBe(
    "managed · running · display :99 · 127.0.0.1:46001 · security VncAuth",
  );
});

it("builds status-all overview rows from the shared surface", () => {
  const rows = buildStatusAllOverviewRows({
    surface: {
      ...params.surface,
      tailscaleMode: "off",
      tailscaleHttpsUrl: null,
      gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
    },
    summary: {
      ...params.summary,
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
    agentStatus: params.agentStatus,
  });

  expect(Object.fromEntries(rows.map(({ Item, Value }) => [Item, Value]))).toMatchObject({
    Version: VERSION,
    OS: "macOS",
    Config: "/tmp/openclaw.json",
    "Gateway self": "gateway app 1.2.3",
    Update: expect.stringContaining("behind 2"),
    "Update restart": "restart pending health verification",
    Security: "Run: openclaw security audit --deep",
    "Secret egress proxy": "Check OpenSSL, then retry the request.",
    "Degraded secrets": "1 degraded · capability:tts",
    "Degraded plugins": "1 configured-unavailable · discord",
    Secrets: "2 diagnostics",
  });
});

it("uses unknown only when Gateway self metadata is absent", () => {
  const surface = { ...params.surface, gatewaySelf: {} };
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
