import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as terminalTable from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import { createStatusCommandReportDataParams } from "./status.test-support.js";

const fixture = vi.hoisted(() => ({ empty: false }));

// mock-isolation: Report layout needs fixed backup facts, not a live database read.
vi.mock("../state/backup-run-records.js", () => ({
  readBackupRunFreshness: async () => ({}),
}));
vi.mock("./status-overview-rows.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-overview-rows.ts")>()),
  buildStatusCommandOverviewRows: () => [{ Item: "OS", Value: "macOS" }],
}));
vi.mock("./status.command-sections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status.command-sections.js")>()),
  buildStatusPluginCompatibilityLines: () => (fixture.empty ? [] : ["plugin warning"]),
  buildStatusPairingRecoveryLines: () => (fixture.empty ? [] : ["pairing needed"]),
  buildStatusModelSelectionLines: () => (fixture.empty ? [] : ["model warning"]),
  buildStatusSecurityAuditLines: () => ["audit line"],
  buildStatusSessionsRows: () => (fixture.empty ? [] : [{ Key: "main" }]),
  buildStatusSystemEventsRows: () => (fixture.empty ? [] : [{ Event: "queued" }]),
  buildStatusSystemEventsTrailer: () => "… +1 more",
  buildStatusHealthRows: () => (fixture.empty ? [] : [{ Item: "Gateway" }]),
  buildStatusFooterLines: () => ["FAQ", "Next steps:"],
}));

const renderTable: typeof terminalTable.renderTable = ({ columns, rows }) =>
  `table:${columns.map((column) => column.header).join("+")}:${rows.length} \n\t`;

beforeEach(() => {
  fixture.empty = false;
  vi.spyOn(theme, "heading").mockImplementation((text) => `# ${String(text)}`);
  vi.spyOn(theme, "muted").mockImplementation(String);
  vi.spyOn(terminalTable, "renderTable").mockImplementation(renderTable);
});
afterEach(() => vi.restoreAllMocks());

it("renders the full report in section order and trims table output", async () => {
  const params = createStatusCommandReportDataParams({ opts: { deep: true, verbose: false } });
  expect((await buildStatusCommandReportLines(params)).join("\n")).toBe(
    [
      "# OpenClaw status",
      "# Overview\ntable:Item+Value:1",
      "# Plugin compatibility\nplugin warning",
      "pairing needed",
      "# Model selection\nmodel warning",
      "# Security audit\naudit line",
      "# Channels\ntable:Channel+Enabled+State+Detail:1",
      "# Sessions\ntable:Key+Kind+Age+Model+Runtime+Tokens:1",
      "# System events\ntable:Event:1\n… +1 more",
      "# Health\ntable:Item+Status+Detail:1",
      "# Usage\nusage line",
      "FAQ\nNext steps:",
    ].join("\n\n"),
  );
});

it("renders empty-state messages and omits absent sections", async () => {
  fixture.empty = true;
  const lines = await buildStatusCommandReportLines(
    createStatusCommandReportDataParams({ channels: { rows: [] }, usageLines: undefined }),
  );
  expect(lines.join("\n")).toBe(
    [
      "# OpenClaw status",
      "# Overview\ntable:Item+Value:1",
      "# Security audit\naudit line",
      "# Channels\nNo channels configured",
      "# Sessions\nNo sessions",
      "FAQ\nNext steps:",
    ].join("\n\n"),
  );
});
