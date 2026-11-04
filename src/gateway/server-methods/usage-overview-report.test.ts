import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import { buildUsageOverview } from "../../shared/usage-overview.js";
import type { SessionUsageEntry } from "../../shared/usage-types.js";
import { withVisibleUsageOverviewRows } from "./usage-overview-report.js";

it("restores page and selected metadata by agent, keeping the last duplicate and report usage", () => {
  const usage = createEmptyCostUsageTotals();
  const rows: SessionUsageEntry[] = [
    { key: "shared", agentId: "a", label: "Report A", updatedAt: 50, usage },
    { key: "shared", agentId: "b", label: "Report B", updatedAt: 40, usage },
    { key: "shared", agentId: "c", label: "Report C", updatedAt: 30, usage },
    { key: "absent", agentId: "a", label: "Absent", updatedAt: 20, usage },
    { key: "selected", agentId: "a", label: "Selected", updatedAt: 10, usage },
  ];
  const slice = buildUsageOverview({
    rows,
    options: { limit: 4, selectedSessions: ["selected"] },
    dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    compact: false,
  });
  const visible: SessionUsageEntry[] = [
    { key: "unrequested", agentId: "a", label: "Unrequested", usage: null },
    { key: "shared", agentId: "a", label: "First A", usage: null },
    { key: "shared", agentId: "b", label: "Visible B", usage: null },
    { key: "selected", agentId: "a", label: "Visible selected", usage: null },
    { key: "shared", agentId: "a", label: "Last A", usage: null },
  ];

  const restored = withVisibleUsageOverviewRows(slice, visible);

  expect(restored.sessions).toEqual([
    { key: "shared", agentId: "a", label: "Last A", usage },
    { key: "shared", agentId: "b", label: "Visible B", usage },
    rows[2],
    rows[3],
  ]);
  expect(restored.overview.selectedRows).toEqual([
    { key: "selected", agentId: "a", label: "Visible selected", usage },
  ]);
});
