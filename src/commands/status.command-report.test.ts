import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as terminalTable from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { buildStatusCommandReportLines } from "./status.command-report.js";

const renderTable: typeof terminalTable.renderTable = ({ columns, rows }) =>
  `table:${columns.map((column) => column.header).join("+")}:${rows.length} \n\t`;

beforeEach(() => {
  vi.spyOn(theme, "heading").mockImplementation((text) => `# ${String(text)}`);
  vi.spyOn(theme, "muted").mockImplementation(String);
  vi.spyOn(terminalTable, "renderTable").mockImplementation(renderTable);
});
afterEach(() => vi.restoreAllMocks());

const params: Parameters<typeof buildStatusCommandReportLines>[0] = {
  width: 120,
  overviewRows: [{ Item: "OS", Value: "macOS" }],
  pluginCompatibilityLines: ["plugin warning"],
  pairingRecoveryLines: ["pairing needed"],
  modelSelectionLines: ["model warning"],
  securityAuditLines: ["audit line"],
  channelsColumns: [{ key: "Channel", header: "Channel" }],
  channelsRows: [{ Channel: "quietchat" }],
  sessionsColumns: [{ key: "Key", header: "Key" }],
  sessionsRows: [{ Key: "main" }],
  systemEventsRows: [{ Event: "queued" }],
  systemEventsTrailer: "… +1 more",
  healthColumns: [{ key: "Item", header: "Item" }],
  healthRows: [{ Item: "Gateway" }],
  usageLines: ["usage line"],
  footerLines: ["FAQ", "Next steps:"],
};

it("renders the full report in section order and trims table output", async () => {
  expect((await buildStatusCommandReportLines(params)).join("\n")).toBe(
    [
      "# OpenClaw status",
      "# Overview\ntable:Item+Value:1",
      "# Plugin compatibility\nplugin warning",
      "pairing needed",
      "# Model selection\nmodel warning",
      "# Security audit\naudit line",
      "# Channels\ntable:Channel:1",
      "# Sessions\ntable:Key:1",
      "# System events\ntable:Event:1\n… +1 more",
      "# Health\ntable:Item:1",
      "# Usage\nusage line",
      "FAQ\nNext steps:",
    ].join("\n\n"),
  );
});

it("renders empty-state messages and omits absent sections", async () => {
  const lines = await buildStatusCommandReportLines({
    ...params,
    pluginCompatibilityLines: [],
    pairingRecoveryLines: [],
    modelSelectionLines: [],
    channelsRows: [],
    sessionsRows: [],
    systemEventsRows: undefined,
    healthColumns: undefined,
    healthRows: undefined,
    usageLines: undefined,
  });
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
