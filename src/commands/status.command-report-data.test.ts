import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as backupRunRecords from "../state/backup-run-records.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import { createStatusCommandReportDataParams } from "./status.test-support.js";

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
  vi.restoreAllMocks();
});

it.each([
  {
    channel: "quietchat",
    accountId: "acct",
    expected: "ok-token · 5m ago · quietchat · account acct",
  },
  { channel: undefined, accountId: undefined, expected: "ok-token · 5m ago" },
])(
  "formats heartbeat age and optional metadata: $expected",
  async ({ channel, accountId, expected }) => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const lines = await buildStatusCommandReportLines(
      createStatusCommandReportDataParams({
        lastHeartbeat: { ts: now - 300_000, status: "ok-token", channel, accountId },
      }),
    );
    expect(stripAnsi(lines.join("\n"))).toContain(expected);
  },
);

it("awaits backup freshness before assembling the overview", async () => {
  const freshness = createDeferred<backupRunRecords.BackupRunFreshness>();
  vi.spyOn(backupRunRecords, "readBackupRunFreshness").mockReturnValueOnce(freshness.promise);
  const pending = buildStatusCommandReportLines(createStatusCommandReportDataParams());
  freshness.resolve({
    latest: {
      id: "failed-backup",
      createdAt: Date.now(),
      archivePath: "/backups/archive.tar.gz",
      status: "failed",
      kind: "archive",
    },
  });
  expect(stripAnsi((await pending).join("\n"))).toContain("last attempt failed just now (archive)");
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
  const lines = await buildStatusCommandReportLines(
    createStatusCommandReportDataParams({ securityAudit: undefined }),
  );
  expect(stripAnsi(lines.join("\n"))).toContain(
    "Skipped in fast status. Full report: openclaw security audit\nDeep check: openclaw status --deep",
  );
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
  const lines = await buildStatusCommandReportLines({
    ...params,
    summary: { ...params.summary, sqliteWal },
    opts: { deep: true },
    tableWidth: 500,
  });
  const output = stripAnsi(lines.join("\n"));
  expect(output).toMatch(/SQLite WAL[^\n]*WARN/);
  expect(output).toContain("checkpoint blocked");
  expect(output).toContain("WAL 128.0 MiB");
  expect(output).toContain("frames 100/4000 checkpointed");
  expect(output).toContain("last complete 2026-09-13T11:00:00.000Z");
  expect(output).toContain("observed 2026-09-13T12:00:00.000Z");
  expect(output).toContain("openclaw gateway restart");
});
