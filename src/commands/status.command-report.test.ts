import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as terminalTable from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import { createStatusCommandReportDataParams } from "./status.test-support.js";

// mock-isolation: Report layout needs fixed backup facts, not a live database read.
vi.mock("../state/backup-run-records.js", () => ({ readBackupRunFreshness: async () => ({}) }));
vi.mock("./status-overview-rows.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-overview-rows.ts")>()),
  buildStatusCommandOverviewRows: () => [{ Item: "OS", Value: "macOS" }],
}));

beforeEach(() => {
  vi.spyOn(theme, "heading").mockImplementation((text) => `# ${String(text)}`);
  for (const color of ["success", "warn", "muted", "error"] as const) {
    vi.spyOn(theme, color).mockImplementation(String);
  }
  vi.spyOn(terminalTable, "renderTable").mockImplementation(
    ({ columns, rows }) =>
      `table:${columns.map((column) => column.header).join("+")}:${rows.length} \n\t`,
  );
});
afterEach(() => vi.restoreAllMocks());

it.each([true, false])("orders and trims report sections (full=%s)", async (full) => {
  const params = createStatusCommandReportDataParams({ opts: { deep: true, verbose: false } });
  params.summary.queuedSystemEvents = full ? ["one", "two", "three", "four", "five", "six"] : [];
  if (!full) {
    Object.assign(params, {
      channels: { rows: [] },
      usageLines: undefined,
      pluginCompatibility: [],
      pairingRecovery: null,
      health: undefined,
      securityAudit: undefined,
    });
    params.summary.sessions.recent = [];
  }
  const lines = await buildStatusCommandReportLines(params);
  const output = lines.join("\n");
  expect(lines.filter((line) => line.startsWith("# "))).toEqual([
    "# OpenClaw status",
    "# Overview",
    ...(full ? ["# Plugin compatibility"] : []),
    "# Security audit",
    "# Channels",
    "# Sessions",
    ...(full ? ["# System events", "# Health", "# Usage"] : []),
  ]);
  if (full) {
    expect(output).toContain("# Overview\ntable:Item+Value:1\n\n# Plugin compatibility");
    expect(output).toContain(
      "# System events\ntable:Event:5\n… +1 more\n\n# Health\ntable:Item+Status+Detail:1\n\n# Usage\nusage line\n\nFAQ: https://docs.openclaw.ai/faq",
    );
  } else {
    expect(output).toContain(
      "# Channels\nNo channels configured\n\n# Sessions\nNo sessions\n\nFAQ: https://docs.openclaw.ai/faq",
    );
  }
  expect(output).not.toContain(" \n\t");
  expect(output).toContain(
    "FAQ: https://docs.openclaw.ai/faq\nTroubleshooting: https://docs.openclaw.ai/troubleshooting\nSupport: https://community.openclaw.ai/",
  );
  expect(lines.at(-1)).toBe("  Need to test channels? openclaw status --deep");
});
