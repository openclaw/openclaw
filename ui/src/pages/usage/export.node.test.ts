import { afterEach, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";
import * as downloads from "../../lib/download.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import * as toasts from "../../lib/toast.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createUsageExportRequest } from "./export.ts";

afterEach(() => vi.restoreAllMocks());

it.each([
  { format: "json", status: "partial" },
  { format: "sessions-csv", status: "stale" },
  { format: "daily-csv", status: "refreshing" },
] as const)(
  "refuses $status $format exports and allows a complete retry",
  async ({ format, status }) => {
    const totals = {
      ...createEmptyCostUsageTotals(),
      input: 100,
      totalTokens: 100,
      totalCost: 0.5,
    };
    const result: SessionsUsageResult = {
      updatedAt: 1,
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      sessions: [
        { key: "agent:main:known", usage: totals },
        { key: "agent:main:pending", usage: null, computing: true },
      ],
      totals,
      aggregates: {
        messages: { total: 1, user: 0, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
        costDaily: [{ ...totals, date: "2026-10-01" }],
      },
      cacheStatus: { status, cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
    };
    const request = vi.fn(async () => result);
    const { gateway } = createApplicationGateway();
    Object.assign(gateway.snapshot, {
      client: createTestGatewayClient(request),
      phase: "connected",
    });
    const binding = new GatewayPageBinding(() => {}, { getGateway: () => gateway });
    binding.connect();
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const toast = vi.spyOn(toasts, "showToast").mockReturnValue(true);
    const exporter = createUsageExportRequest(
      () => {},
      binding,
      () => ({
        startDate: "2026-10-01",
        endDate: "2026-10-01",
        scope: "instance",
        timeZone: "utc",
      }),
    );
    try {
      await exporter.run(format);
      expect(request).toHaveBeenCalledOnce();
      expect(download).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith({
        message:
          "Export: Usage data is incomplete. Refresh usage and try again, or narrow the date range.",
      });
      expect(exporter.pending).toBe(false);

      result.sessions = [result.sessions[0]!];
      result.cacheStatus = { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 };
      await exporter.run(format);
      expect(download).toHaveBeenCalledOnce();
      expect(download.mock.calls[0]?.[1]).toContain("100");
      expect(download.mock.calls[0]?.[1]).toContain("0.5");
      expect(toast).toHaveBeenCalledOnce();
    } finally {
      binding.dispose();
    }
  },
);
