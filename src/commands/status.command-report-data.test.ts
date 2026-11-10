import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as backupRunRecords from "../state/backup-run-records.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import { createStatusCommandReportDataParams, createStatusHealth } from "./status.test-support.js";

// mock-isolation: Keep database inspection in its own owner proof; these tests exercise report data.
vi.mock("./status-database-engines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-database-engines.js")>()),
  resolveStatusDatabaseEngines: async () => ({ source: "admitted", stores: [] }),
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROFILE", undefined);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function report(overrides: Parameters<typeof createStatusCommandReportDataParams>[0] = {}) {
  const lines = await buildStatusCommandReportLines(createStatusCommandReportDataParams(overrides));
  return stripAnsi(lines.join("\n"));
}

it.each([
  ["quietchat", "acct", "ok-token · 5m ago · quietchat · account acct"],
  [undefined, undefined, "ok-token · 5m ago"],
])("formats heartbeat age with channel %s and account %s", async (channel, accountId, expected) => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  const output = await report({
    lastHeartbeat: { ts: now - 300_000, status: "ok-token", channel, accountId },
  });
  expect(output).toContain(expected);
});

it("awaits backup freshness before assembling the overview", async () => {
  const freshness = createDeferred<backupRunRecords.BackupRunFreshness>();
  vi.spyOn(backupRunRecords, "readBackupRunFreshness").mockReturnValueOnce(freshness.promise);
  const pending = report();
  freshness.resolve({
    latest: {
      id: "failed-backup",
      createdAt: Date.now(),
      archivePath: "/backups/archive.tar.gz",
      status: "failed",
      kind: "archive",
    },
  });
  expect(await pending).toContain("last attempt failed just now (archive)");
});

it("keeps pending startup guidance distinct from reachability failure", async () => {
  const params = createStatusCommandReportDataParams();
  const lines = await buildStatusCommandReportLines({
    ...params,
    surface: {
      ...params.surface,
      gatewayReachable: false,
      gatewayProbe: { startupPhase: "plugins", error: null },
    },
    health: undefined,
    lastHeartbeat: null,
  });
  expect(stripAnsi(lines.join("\n"))).toContain(
    "not checked (gateway still starting; phase plugins)",
  );
  expect(lines.at(-1)).toBe("  Retry after startup: openclaw status --deep");
  expect(lines.join("\n")).not.toContain("Fix reachability first");
});

it("shows skipped audit text when fast status omits the security audit", async () => {
  expect(await report({ securityAudit: undefined })).toContain(
    "Skipped in fast status. Full report: openclaw security audit\nDeep check: openclaw status --deep",
  );
});

it("shows the audit suppression marker among important findings", async () => {
  const output = await report({
    securityAudit: {
      ts: Date.now(),
      summary: { critical: 0, warn: 0, info: 2 },
      findings: [
        { checkId: "other-info", severity: "info", title: "Other info", detail: "info detail" },
        {
          checkId: "security.audit.suppressions.active",
          severity: "info",
          title: "Security audit suppressions configured",
          detail: "1 configured suppression(s)",
        },
      ],
    },
  });
  expect(output).toContain("INFO Security audit suppressions configured");
  expect(output).not.toContain("Other info");
  expect(output).not.toContain("No critical or warn findings detected.");
});

it.each([false, true])(
  "reports auxiliary health warnings only when degraded=%s",
  async (degraded) => {
    const quarantined = [
      {
        engineId: "synthetic-context",
        operation: "ingest",
        reason: "provider failed",
        failedAt: 1,
      },
    ];
    const output = await report({
      health: createStatusHealth({
        contextEngines: { quarantined: degraded ? quarantined : [] },
        configReload: { hotReloadStatus: degraded ? "disabled" : "active" },
      }),
      tableWidth: 240,
    });
    if (degraded) {
      expect(output).toMatch(/Context engine[^\n]*WARN/);
      expect(output).toContain("1 quarantined; downgraded to legacy: synthetic-context");
      expect(output).toMatch(/Config hot reload[^\n]*WARN/);
      expect(output).toContain("watcher retries exhausted; restart the gateway to restore it");
    } else {
      expect(output).not.toContain("Context engine");
      expect(output).not.toContain("Config hot reload");
    }
  },
);

it("renders the recorded SQLite checkpoint warning in deep status", async () => {
  const params = createStatusCommandReportDataParams();
  const sqliteWal = createSqliteWalHealth({
    observedAtMs: Date.parse("2026-09-13T12:00:00.000Z"),
    lastCompletedAtMs: Date.parse("2026-09-13T11:00:00.000Z"),
  });
  const output = await report({
    ...params,
    summary: { ...params.summary, sqliteWal },
    opts: { deep: true },
    tableWidth: 500,
  });
  expect(output).toMatch(/SQLite WAL[^\n]*WARN/);
  expect(output).toContain("checkpoint blocked");
  expect(output).toContain("WAL 128.0 MiB");
  expect(output).toContain("frames 100/4000 checkpointed");
  expect(output).toContain("last complete 2026-09-13T11:00:00.000Z");
  expect(output).toContain("observed 2026-09-13T12:00:00.000Z");
  expect(output).toContain("openclaw gateway restart");
});
