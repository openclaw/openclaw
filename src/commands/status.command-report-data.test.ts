import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as backupRunRecords from "../state/backup-run-records.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";
import { buildStatusCommandReportData } from "./status.command-report-data.js";
import { createStatusCommandReportDataParams } from "./status.test-support.js";

beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROFILE", undefined);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  {
    enabled: true,
    jobs: 2,
    nextWakeAtMs: null,
    expected: "scheduler enabled · 2 total jobs · no wake scheduled",
  },
  {
    enabled: false,
    jobs: 1,
    nextWakeAtMs: null,
    expected: "scheduler disabled · 1 total job · no wake scheduled",
  },
  {
    enabled: true,
    jobs: 3,
    nextWakeAtMs: Date.parse("2026-09-01T12:00:00.000Z"),
    expected: "scheduler enabled · 3 total jobs · next wake 2026-09-01T12:00:00.000Z",
  },
])("reports scheduler status: $expected", async ({ enabled, jobs, nextWakeAtMs, expected }) => {
  const report = await buildStatusCommandReportData(
    createStatusCommandReportDataParams({
      automations: { ok: true, value: { enabled, jobs, nextWakeAtMs } },
    }),
  );
  const row = expectDefined(
    report.overviewRows.find(({ Item }) => Item === "Automations"),
    "automations row",
  );
  expect(stripAnsi(row.Value)).toBe(expected);
  expect(
    report.overviewRows.some(({ Item }) => Item === "Heartbeat" || Item === "Last heartbeat"),
  ).toBe(false);
});

it("awaits backup freshness before assembling the overview", async () => {
  const freshness = createDeferred<backupRunRecords.BackupRunFreshness>();
  vi.spyOn(backupRunRecords, "readBackupRunFreshness").mockReturnValueOnce(freshness.promise);
  const pending = buildStatusCommandReportData(createStatusCommandReportDataParams());
  freshness.resolve({
    latest: {
      id: "failed-backup",
      createdAt: Date.now(),
      archivePath: "/backups/archive.tar.gz",
      status: "failed",
      kind: "archive",
    },
  });
  expect((await pending).overviewRows.find(({ Item }) => Item === "Backups")?.Value).toBe(
    "last attempt failed just now (archive)",
  );
});

it("keeps pending startup guidance distinct from reachability failure", async () => {
  const params = createStatusCommandReportDataParams();
  const report = await buildStatusCommandReportData({
    ...params,
    surface: {
      ...params.surface,
      gatewayReachable: false,
      gatewayProbe: { startupPhase: "plugins", error: null },
    },
    health: undefined,
    automations: { ok: false, error: "gateway still starting; phase plugins" },
  });
  expect(
    stripAnsi(report.overviewRows.find(({ Item }) => Item === "Automations")?.Value ?? ""),
  ).toBe("unavailable (gateway still starting; phase plugins)");
  expect(report.footerLines.at(-1)).toBe("  Retry after startup: openclaw status --deep");
  expect(report.footerLines.join("\n")).not.toContain("Fix reachability first");
});

it("shows skipped audit text when fast status omits the security audit", async () => {
  const report = await buildStatusCommandReportData(
    createStatusCommandReportDataParams({ securityAudit: undefined }),
  );
  expect(report.securityAuditLines.map(stripAnsi)).toEqual([
    "Skipped in fast status. Full report: openclaw security audit",
    "Deep probe: openclaw status --deep",
  ]);
});

it("renders the recorded SQLite checkpoint warning in deep status", async () => {
  const params = createStatusCommandReportDataParams();
  const sqliteWal = createSqliteWalHealth({
    state: "blocked",
    warning: true,
    consecutiveBlocked: 2,
    observedAtMs: Date.parse("2026-09-13T12:00:00.000Z"),
    walBytes: 128 * 1024 * 1024,
    checkpointedFrames: 100,
    lastCompletedAtMs: Date.parse("2026-09-13T11:00:00.000Z"),
  });
  const report = await buildStatusCommandReportData({
    ...params,
    summary: { ...params.summary, sqliteWal },
    opts: { deep: true },
  });
  const row = expectDefined(
    report.healthRows?.find(({ Item }) => Item === "SQLite WAL"),
    "SQLite WAL warning",
  );
  expect(stripAnsi(row.Status)).toBe("WARN");
  expect(row.Detail).toContain("checkpoint blocked");
  expect(row.Detail).toContain("WAL 128.0 MiB");
  expect(row.Detail).toContain("frames 100/4000 checkpointed");
  expect(row.Detail).toContain("last complete 2026-09-13T11:00:00.000Z");
  expect(row.Detail).toContain("observed 2026-09-13T12:00:00.000Z");
  expect(row.Detail).toContain("openclaw gateway restart");
});
