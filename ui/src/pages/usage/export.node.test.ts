import { afterEach, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { buildUsageOverview } from "../../../../src/shared/usage-overview.js";
import type { SessionUsageEntry, SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import * as downloads from "../../lib/download.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { SessionUsageQuery } from "../../lib/sessions/usage.ts";
import * as toasts from "../../lib/toast.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createUsageExportRequest } from "./export.ts";

const bindings: GatewayPageBinding[] = [];
const date = "2026-10-01";
afterEach(() => {
  for (const binding of bindings.splice(0)) {
    binding.dispose();
  }
  vi.restoreAllMocks();
});

function setupExport(
  request: Parameters<typeof createTestGatewayClient>[0],
  query: () => Partial<SessionUsageQuery> = () => ({}),
) {
  const { gateway } = createApplicationGateway();
  Object.assign(gateway.snapshot, { client: createTestGatewayClient(request), phase: "connected" });
  const binding = new GatewayPageBinding(() => {}, { getGateway: () => gateway });
  binding.connect();
  bindings.push(binding);
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
  const exporter = createUsageExportRequest(
    () => {},
    binding,
    () => ({
      startDate: date,
      endDate: date,
      scope: "instance",
      timeZone: "utc",
      ...query(),
    }),
  );
  return { download, toast, exporter };
}

const totals = { ...createEmptyCostUsageTotals(), input: 100, totalTokens: 100, totalCost: 0.5 };
const completeUsage = {
  ...totals,
  computedAt: 1,
  dailyBreakdown: [{ ...totals, date, tokens: 100, cost: 0.5 }],
};
const cacheStatus = { cachedFiles: 1, pendingFiles: 1, staleFiles: 0 };
const dayBucket = { mode: "utc-offset", utcOffsetMinutes: 0 } as const;

function usageResult(
  params: Omit<Parameters<typeof buildUsageOverview>[0], "dayBucket">,
): SessionsUsageResult {
  return {
    ...buildUsageOverview({ ...params, dayBucket }),
    updatedAt: 1,
    startDate: date,
    endDate: date,
    cacheStatus: {
      ...cacheStatus,
      status: "partial",
      pendingFiles: params.rows.filter((row) => row.computing).length,
    },
  };
}

it.each([
  { format: "json", status: "partial" },
  { format: "sessions-csv", status: "stale" },
  { format: "daily-csv", status: "refreshing" },
] as const)(
  "refuses $status $format exports and allows a complete retry",
  async ({ format, status }) => {
    const result = usageResult({
      rows: [
        { key: "agent:main:known", usage: completeUsage },
        { key: "agent:main:pending", usage: null, computing: true },
      ],
      options: {},
    });
    delete result.overview;
    result.cacheStatus = { ...cacheStatus, status };
    const request = vi.fn(async () => result);
    const { download, toast, exporter } = setupExport(request);
    await exporter.run(format);
    expect(request).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      message:
        "Export: Usage data is incomplete. Refresh usage and try again, or narrow the date range.",
    });
    expect(exporter.pending).toBe(false);

    result.sessions = [result.sessions[0]!];
    result.cacheStatus = { ...cacheStatus, status: "fresh", pendingFiles: 0 };
    await exporter.run(format);
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0]?.[1]).toContain("100");
    expect(download.mock.calls[0]?.[1]).toContain("0.5");
    expect(toast).toHaveBeenCalledOnce();
  },
);

it.each(["json", "sessions-csv", "daily-csv"] as const)(
  "exports a complete selected session despite an incomplete roster: %s",
  async (format) => {
    const selectedUsage = { ...completeUsage };
    const selected: SessionUsageEntry = {
      key: "agent:main:known",
      updatedAt: 1,
      modelProvider: "openai",
      usage: selectedUsage,
    };
    const pending: SessionUsageEntry[] = Array.from({ length: 51 }, (_, index) => ({
      key: `agent:main:pending-${index}`,
      updatedAt: index + 2,
      usage: null,
      computing: true,
    }));
    const excluded: SessionUsageEntry = {
      key: "agent:main:excluded",
      modelProvider: "anthropic",
      usage: { ...totals, totalTokens: 200 },
    };
    let query = "";
    const selectedSessions = [selected.key];
    const request = vi.fn(async () =>
      usageResult({
        rows: [selected, excluded, ...pending],
        options: {
          selectedSessions,
          query,
          limit: format === "daily-csv" ? 50 : Number.MAX_SAFE_INTEGER,
        },
        compact: format === "daily-csv",
      }),
    );
    const { download, toast, exporter } = setupExport(request, () => ({
      selectedSessions,
      query,
    }));
    await exporter.run(format);
    expect(download).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
    expect(download.mock.calls[0]?.[1]).toContain("100");
    expect(download.mock.calls[0]?.[1]).toContain("0.5");
    expect(download.mock.calls[0]?.[1]).not.toContain("pending-");

    // A family can have a subtotal while another instance is still computing.
    for (const patch of [
      { computing: true },
      { usage: { ...selectedUsage, staleSince: 0 } },
      { usage: { ...selectedUsage, refreshing: true } },
      { usage: null },
    ]) {
      Object.assign(selected, { computing: false, usage: selectedUsage }, patch);
      await exporter.run(format);
    }
    selected.usage = selectedUsage;
    selectedSessions.push("agent:main:missing");
    await exporter.run(format);
    expect(download).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledTimes(5);

    selectedSessions.pop();
    selectedSessions.push(excluded.key);
    query = "provider:openai";
    await exporter.run(format);
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[1]?.[1]).toContain("100");
    expect(download.mock.calls[1]?.[1]).not.toContain("excluded");

    // Missing usage can hide a selected row from a usage-dependent filter.
    query = "minTokens:1";
    excluded.usage = null;
    excluded.computing = true;
    await exporter.run(format);
    expect(download).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(6);
  },
);
