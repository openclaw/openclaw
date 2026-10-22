import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as terminalTable from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";
import { createStatusCommandReportDataParams } from "./status.test-support.js";

// mock-isolation: Report layout needs fixed backup facts, not a live database read.
vi.mock("../state/backup-run-records.js", () => ({
  readBackupRunFreshness: async () => ({}),
}));
vi.mock("./status-overview-rows.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status-overview-rows.ts")>()),
  buildStatusCommandOverviewRows: () => [{ Item: "OS", Value: "macOS" }],
}));
const renderTable: typeof terminalTable.renderTable = ({ columns, rows }) =>
  `table:${columns.map((column) => column.header).join("+")}:${rows.length} \n\t`;

beforeEach(() => {
  vi.spyOn(theme, "heading").mockImplementation((text) => `# ${String(text)}`);
  for (const color of ["success", "warn", "muted", "error"] as const) {
    vi.spyOn(theme, color).mockImplementation(String);
  }
  vi.spyOn(terminalTable, "renderTable").mockImplementation(renderTable);
});
afterEach(() => vi.restoreAllMocks());

it("renders the full report in section order and trims table output", async () => {
  const params = createStatusCommandReportDataParams({ opts: { deep: true, verbose: false } });
  params.summary = {
    ...params.summary,
    queuedSystemEvents: ["one", "two", "three", "four", "five", "six"],
    sessions: {
      ...params.summary.sessions,
      recent: params.summary.sessions.recent.map((session) => ({
        ...session,
        selectedModel: "fixture/alternate",
        modelSelectionReason: "session override",
      })),
    },
  };
  const lines = await buildStatusCommandReportLines(params);
  const output = lines.join("\n");
  expect(lines.filter((line) => line.startsWith("# "))).toEqual([
    "# OpenClaw status",
    "# Overview",
    "# Plugin compatibility",
    "# Model selection",
    "# Security audit",
    "# Channels",
    "# Sessions",
    "# System events",
    "# Health",
    "# Usage",
  ]);
  expect(output).toContain(
    "# Overview\ntable:Item+Value:1\n\n# Plugin compatibility\n  WARN a legacy",
  );
  expect(output).toContain(
    "\n\nGateway pairing approval required.\nRecovery: openclaw devices approve req-1\nFallback: openclaw devices approve --latest\nInspect: openclaw devices list\n\n# Model selection\n",
  );
  expect(output).toContain(
    "# Channels\ntable:Channel+Enabled+State+Detail:1\n\n# Sessions\ntable:Key+Kind+Age+Model+Runtime+Tokens:1",
  );
  expect(output).toContain(
    "# System events\ntable:Event:5\n… +1 more\n\n# Health\ntable:Item+Status+Detail:1\n\n# Usage\nusage line\n\nFAQ: https://docs.openclaw.ai/faq",
  );
  expect(output).toContain(
    "FAQ: https://docs.openclaw.ai/faq\nTroubleshooting: https://docs.openclaw.ai/troubleshooting\nSupport: https://community.openclaw.ai/",
  );
  expect(output).not.toContain(" \n\t");
  expect(lines.at(-1)).toBe("  Need to test channels? openclaw status --deep");
});

it("renders empty-state messages and omits absent sections", async () => {
  const params = createStatusCommandReportDataParams();
  const lines = await buildStatusCommandReportLines(
    createStatusCommandReportDataParams({
      channels: { rows: [] },
      usageLines: undefined,
      pluginCompatibility: [],
      pairingRecovery: null,
      health: undefined,
      securityAudit: undefined,
      summary: {
        ...params.summary,
        queuedSystemEvents: [],
        sessions: { ...params.summary.sessions, recent: [] },
      },
    }),
  );
  expect(lines.filter((line) => line.startsWith("# "))).toEqual([
    "# OpenClaw status",
    "# Overview",
    "# Security audit",
    "# Channels",
    "# Sessions",
  ]);
  expect(lines.join("\n")).toContain(
    "# Channels\nNo channels configured\n\n# Sessions\nNo sessions\n\nFAQ: https://docs.openclaw.ai/faq",
  );
  expect(lines.at(-1)).toBe("  Need to test channels? openclaw status --deep");
});
