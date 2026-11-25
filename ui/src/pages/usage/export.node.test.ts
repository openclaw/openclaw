import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { buildUsageOverview } from "../../../../src/shared/usage-overview.js";
import type { SessionUsageEntry, SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import * as downloads from "../../lib/download.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import * as toasts from "../../lib/toast.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createUsageExportRequest } from "./export.ts";

const date = "2026-10-01";
afterEach(() => vi.restoreAllMocks());

const totals = { ...createEmptyCostUsageTotals(), input: 100, totalTokens: 100, totalCost: 0.5 };
const completeUsage = {
  ...totals,
  computedAt: 1,
  dailyBreakdown: [{ ...totals, date, tokens: 100, cost: 0.5 }],
};
const cacheStatus = { cachedFiles: 1, pendingFiles: 1, staleFiles: 0 };
const dayBucket = { mode: "utc-offset", utcOffsetMinutes: 0 } as const;

function createExportScenario(
  format: Parameters<ReturnType<typeof createUsageExportRequest>["run"]>[0],
) {
  const selectedUsage = { ...completeUsage };
  const selected: SessionUsageEntry = {
    key: "agent:main:known",
    updatedAt: 1,
    modelProvider: "openai",
    usage: selectedUsage,
  };
  const excluded: SessionUsageEntry = {
    key: "agent:main:excluded",
    modelProvider: "anthropic",
    usage: { ...totals, totalTokens: 200 },
  };
  const pending = Array.from({ length: 51 }, (_, index) => ({
    key: `agent:main:pending-${index}`,
    updatedAt: index + 2,
    usage: null,
    computing: true,
  }));
  const query = { selectedSessions: [selected.key], query: "" };
  const build = (
    rows: SessionUsageEntry[] = [selected, excluded, ...pending],
  ): SessionsUsageResult => ({
    ...buildUsageOverview({
      rows,
      options: { ...query, limit: format === "daily-csv" ? 50 : Number.MAX_SAFE_INTEGER },
      dayBucket,
      compact: format === "daily-csv",
    }),
    updatedAt: 1,
    startDate: date,
    endDate: date,
    cacheStatus: { ...cacheStatus, status: "partial", pendingFiles: pending.length },
  });
  const request = vi.fn(async () => build());
  const { gateway } = createApplicationGateway();
  Object.assign(gateway.snapshot, { client: createTestGatewayClient(request), phase: "connected" });
  const binding = new GatewayPageBinding(() => {}, { getGateway: () => gateway });
  binding.connect();
  onTestFinished(() => binding.dispose());
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
  const exporter = createUsageExportRequest(
    () => {},
    binding,
    () => ({ startDate: date, endDate: date, scope: "instance", timeZone: "utc", ...query }),
  );
  return {
    download,
    toast,
    exporter,
    request,
    build,
    selected,
    selectedUsage,
    excluded,
    query,
  };
}

it("refuses incomplete exports and allows a complete retry", async () => {
  const format = "json";
  const { request, build, query, selected, download, toast, exporter } =
    createExportScenario(format);
  query.selectedSessions.length = 0;
  const result = build();
  delete result.overview;
  result.cacheStatus = { ...cacheStatus, status: "partial" };
  request.mockResolvedValue(result);
  await exporter.run(format);
  expect(download).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledOnce();
  expect(toast.mock.calls[0]?.[0].message).toContain("incomplete");
  expect(exporter.pending).toBe(false);

  Object.assign(result, build([selected]));
  delete result.overview;
  result.cacheStatus = { ...cacheStatus, status: "fresh", pendingFiles: 0 };
  await exporter.run(format);
  expect(download).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledOnce();
});

it.each(["json", "sessions-csv", "daily-csv"] as const)(
  "exports a complete selected session despite an incomplete roster: %s",
  async (format) => {
    const { selected, selectedUsage, excluded, query, download, toast, exporter } =
      createExportScenario(format);
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
    query.selectedSessions.push("agent:main:missing");
    await exporter.run(format);
    expect(download).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledTimes(5);

    query.selectedSessions.pop();
    query.selectedSessions.push(excluded.key);
    query.query = "provider:openai";
    await exporter.run(format);
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[1]?.[1]).toContain("100");
    expect(download.mock.calls[1]?.[1]).not.toContain("excluded");

    // Missing usage can hide a selected row from a usage-dependent filter.
    query.query = "minTokens:1";
    excluded.usage = null;
    excluded.computing = true;
    await exporter.run(format);
    expect(download).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledTimes(6);
  },
);
