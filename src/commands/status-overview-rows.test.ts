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
const value = (item: string) => findRowValue(buildStatusCommandOverviewRows(params), item);
function allRows(overrides: Partial<Parameters<typeof buildStatusAllOverviewRows>[0]> = {}) {
  return buildStatusAllOverviewRows({
    ...params,
    configPath: "/fixture/openclaw.json",
    secretDiagnosticsCount: 0,
    ...overrides,
  });
}

function backup(createdAt: number, kind: "git" | "archive", status: "ok" | "failed") {
  return { id: "fixture", archivePath: "", createdAt, kind, status };
}

it("counts recent activity in the status-all agent overview", () => {
  const rows = allRows({
    agentStatus: {
      bootstrapPendingCount: 2,
      totalSessions: 3,
      agents: [
        { id: "main", lastActiveAgeMs: 5_000 },
        { id: "ops", lastActiveAgeMs: 11 * 60_000 },
        { id: "idle", lastActiveAgeMs: null },
      ],
    },
  });
  expect(findRowValue(rows, "Agents")).toBe("3 total · 2 bootstrapping · 1 active · 3 sessions");
  expect(findRowValue(rows, "Secrets")).toBe("none");
  expect(findRowValue(allRows({ secretDiagnosticsCount: 1 }), "Secrets")).toBe("1 diagnostic");
});

it("reports events, skipped probes and distinct incompatible plugins", () => {
  params.health = undefined;
  params.pluginCompatibility = ["a", "a", "b"].map((pluginId) => ({
    pluginId,
    code: "hook-only",
    severity: "warn",
    message: "fixture",
  }));
  const rows = buildStatusCommandOverviewRows(params);
  expect(findRowValue(rows, "Events")).toBe("2 queued");
  expect(findRowValue(rows, "Checks")).toBe("muted(skipped (use --deep))");
  expect(findRowValue(rows, "Plugin compatibility")).toBe("warn(3 notices · 2 plugins)");
  params.summary.queuedSystemEvents = [];
  params.pluginCompatibility = [];
  const emptyRows = buildStatusCommandOverviewRows(params);
  expect(findRowValue(emptyRows, "Events")).toBe("none");
  expect(findRowValue(emptyRows, "Plugin compatibility")).toBe("ok(none)");
});

it("reports stored sessions, default context and multiple or absent stores", () => {
  params.summary.sessions = { ...params.summary.sessions, paths: ["store.json", "other.json"] };
  expect(value("Sessions")).toBe("2 stored · default gpt-5.5 (12k ctx) · 2 stores");
  params.summary.sessions = {
    ...params.summary.sessions,
    count: 0,
    paths: [],
    defaults: { model: null, contextTokens: null },
  };
  expect(value("Sessions")).toBe("0 stored · default unknown · unknown");
});

it("keeps default status concise and reports configured family choices without secrets", () => {
  expect(value("Database engines (configured)")).toBeUndefined();
  const all = allRows();
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
  const database = value("Database engines (configured)");
  expect(database).toContain("state: default=sqlite, override=inherit, effective=sqlite");
  expect(database).toContain("workboard: default=sqlite, override=postgres, effective=postgres");
  expect(database).toContain("quarantine: default=sqlite, override=fixed local, effective=sqlite");
  expect(database).not.toContain("secret");
  expect(database).not.toContain("experimental");
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

it("redacts both load and runtime service inspection errors", () => {
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
  expect(value("Telemetry")).toBe(expected);
});

it("marks skipped memory inspection as not checked in fast status output", () => {
  params.memory = null;
  params.memoryPlugin = { enabled: true, slot: "memory-lancedb-pro" };
  expect(value("Memory")).toBe("muted(enabled (plugin memory-lancedb-pro) · not checked)");
});

it("renders native provider health without legacy index counters", () => {
  params.memory = {
    agentId: "main",
    provider: "records",
    health: { status: "degraded", message: "warming" },
  };
  expect(value("Memory")).toBe("plugin records · warn(degraded) · warming");
});

it("shows supported remediation for an enabled automation without a route", () => {
  params.summary.heartbeat = {
    defaultAgentId: "main",
    agents: [
      { agentId: "main", enabled: true, every: "scheduled", everyMs: null, waitingForRoute: true },
    ],
  };
  const heartbeat = value("Heartbeat");
  expect(heartbeat).toContain("scheduled (main; waiting for delivery route");
  expect(heartbeat).toContain('commands.ownerAllowFrom=["telegram:123456789"]');
  expect(heartbeat).toContain("edit the automation delivery channel and recipient");
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
  expect(value("Host desktop")).toBe(
    "managed · running · display :99 · 127.0.0.1:46001 · security VncAuth",
  );
});

it("shows utility model capability warnings in normal and full status", () => {
  expect(value("Utility model")).toBeUndefined();
  params.summary.utilityModelWarnings = [
    { path: "agents.defaults.utilityModel", message: "fixture-cli/small cannot disable tools." },
  ];
  expect(value("Utility model")).toBe(
    "warn(agents.defaults.utilityModel: fixture-cli/small cannot disable tools.)",
  );
  const rows = allRows();
  expect(findRowValue(rows, "Utility model")).toBe(
    "agents.defaults.utilityModel: fixture-cli/small cannot disable tools.",
  );
});

it("builds status-all overview rows from the shared surface", () => {
  const rows = allRows({
    summary: {
      ...params.summary,
      modelReasoningWarning: "Model ollama/qwen3:4b emitted hidden reasoning; set reasoning:true.",
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
    configPath: "/tmp/openclaw.json",
    secretDiagnosticsCount: 2,
    updateRows: [{ Item: "Update restart", Value: "restart pending health verification" }],
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
    "Degraded secrets":
      "1 degraded · cold capability:tts (tts.providers.elevenlabs.apiKey): secret reference was not found",
    "Degraded plugins": "1 configured-unavailable · discord",
    "Model reasoning": "Model ollama/qwen3:4b emitted hidden reasoning; set reasoning:true.",
    Secrets: "2 diagnostics",
  });
});

it("uses unknown only when Gateway self metadata is absent", () => {
  const surface = { ...params.surface, gatewaySelf: {} };
  const rows = allRows({ surface });

  expect(findRowValue(rows, "Gateway self")).toBe("unknown");
  expect(
    findRowValue(buildStatusCommandOverviewRows({ ...params, surface }), "Gateway self"),
  ).toBeUndefined();
});
