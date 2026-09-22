// Status command report tests cover complete output and preparation/render ordering.
import { describe, expect, it } from "vitest";
import { buildStatusCommandReportLines } from "./status.command-report.ts";

function createRenderTable() {
  return ({ columns, rows }: { columns: Array<Record<string, unknown>>; rows: unknown[] }) =>
    `table:${columns.map((column) => String(column.header)).join("+")}:${rows.length} \n\t`;
}

describe("buildStatusCommandReportLines", () => {
  it("keeps prepared snapshots and live optional rows in the full report", async () => {
    const channelsColumns = [{ key: "Channel", header: "Channel" }];
    const healthRows: Array<Record<string, string>> = [];
    const pairingRecoveryLines = ["pairing needed"];
    const footerLines = ["FAQ", "Next steps:"];
    const renderTable = createRenderTable();
    let firstTable = true;
    const params: Parameters<typeof buildStatusCommandReportLines>[0] = {
      heading: (text) => `# ${text}`,
      muted: (text) => `muted(${text})`,
      renderTable: (input) => {
        if (firstTable) {
          firstTable = false;
          channelsColumns.push({ key: "Late", header: "Late" });
          healthRows.push({ Item: "Gateway" });
          params.healthRows = [{ Item: "replacement one" }, { Item: "replacement two" }];
          pairingRecoveryLines.push("late pairing");
          footerLines.push("late footer");
        }
        return renderTable(input);
      },
      width: 120,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      showTaskMaintenanceHint: true,
      taskMaintenanceHint: "maintenance hint",
      retainedLostTaskLine: "retained lost line",
      pluginCompatibilityLines: ["warn 1"],
      pairingRecoveryLines,
      modelSelectionLines: ["model warning"],
      securityAuditLines: ["audit line"],
      channelsColumns,
      channelsRows: [{ Channel: "quietchat" }],
      sessionsColumns: [{ key: "Key", header: "Key" }],
      sessionsRows: [{ Key: "main" }],
      systemEventsRows: [{ Event: "queued" }],
      systemEventsTrailer: "muted(… +1 more)  ",
      healthColumns: [{ key: "Item", header: "Item" }],
      healthRows,
      usageLines: ["usage line"],
      footerLines,
    };
    const lines = await buildStatusCommandReportLines(params);

    expect(lines).toEqual([
      "# OpenClaw status",
      "",
      "# Overview",
      "table:Item+Value:1",
      "",
      "muted(maintenance hint)",
      "retained lost line",
      "",
      "# Plugin compatibility",
      "warn 1",
      "",
      "pairing needed",
      "",
      "# Model selection",
      "model warning",
      "",
      "# Security audit",
      "audit line",
      "",
      "# Channels",
      "table:Channel:1",
      "",
      "# Sessions",
      "table:Key:1",
      "",
      "# System events",
      "table:Event:1",
      "muted(… +1 more)  ",
      "",
      "# Health",
      "table:Item:1",
      "",
      "# Usage",
      "usage line",
      "",
      "FAQ",
      "Next steps:",
    ]);
  });

  it("omits optional sections when inputs are absent", async () => {
    const lines = await buildStatusCommandReportLines({
      heading: (text) => `# ${text}`,
      muted: (text) => text,
      renderTable: createRenderTable(),
      width: 120,
      overviewRows: [{ Item: "OS", Value: "macOS" }],
      showTaskMaintenanceHint: false,
      taskMaintenanceHint: "ignored",
      pluginCompatibilityLines: [],
      pairingRecoveryLines: [],
      modelSelectionLines: [],
      securityAuditLines: ["audit line"],
      channelsColumns: [{ key: "Channel", header: "Channel" }],
      channelsRows: [{ Channel: "quietchat" }],
      sessionsColumns: [{ key: "Key", header: "Key" }],
      sessionsRows: [{ Key: "main" }],
      footerLines: ["FAQ"],
    });

    expect(lines).not.toContain("# Plugin compatibility");
    expect(lines).not.toContain("# System events");
    expect(lines).not.toContain("# Health");
    expect(lines).not.toContain("# Usage");
    expect(lines.at(-1)).toBe("FAQ");
  });

  it.each([false, true])(
    "prepares empty states before tables (throw: %s)",
    async (throwOnSessions) => {
      const events: string[] = [];
      const renderTable = createRenderTable();
      const result = buildStatusCommandReportLines({
        heading: (text) => {
          events.push(`heading:${text}`);
          return `# ${text}`;
        },
        muted: (text) => {
          events.push(`muted:${text}`);
          if (throwOnSessions && text === "No sessions") {
            throw new Error("stop-before-render");
          }
          return `muted(${text})`;
        },
        renderTable: (input) => {
          events.push("table");
          return renderTable(input);
        },
        width: 120,
        overviewRows: [],
        showTaskMaintenanceHint: true,
        taskMaintenanceHint: "maintenance hint",
        pluginCompatibilityLines: [],
        pairingRecoveryLines: [],
        modelSelectionLines: [],
        securityAuditLines: [],
        channelsColumns: [{ key: "Channel", header: "Channel" }],
        channelsRows: [],
        sessionsColumns: [{ key: "Key", header: "Key" }],
        sessionsRows: [],
        footerLines: [],
      });
      const preparation = [
        "heading:OpenClaw status",
        "muted:maintenance hint",
        "muted:No channels configured",
        "muted:No sessions",
      ];
      if (throwOnSessions) {
        await expect(result).rejects.toThrow("stop-before-render");
        expect(events).toEqual(preparation);
        return;
      }
      expect(await result).toEqual([
        "# OpenClaw status",
        "",
        "# Overview",
        "table:Item+Value:0",
        "",
        "muted(maintenance hint)",
        "",
        "# Security audit",
        "",
        "# Channels",
        "muted(No channels configured)",
        "",
        "# Sessions",
        "muted(No sessions)",
        "",
      ]);
      expect(events).toEqual([
        ...preparation,
        "heading:Overview",
        "table",
        "heading:Security audit",
        "heading:Channels",
        "heading:Sessions",
      ]);
    },
  );
});
