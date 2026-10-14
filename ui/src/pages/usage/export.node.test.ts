import { afterEach, expect, it, vi } from "vitest";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { buildUsageOverview } from "../../../../src/shared/usage-overview.js";
import type { SessionUsageEntry, SessionsUsageResult } from "../../../../src/shared/usage-types.js";
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

it.each(["json", "sessions-csv", "daily-csv"] as const)(
  "exports a complete selected session despite an incomplete roster: %s",
  async (format) => {
    const totals = {
      ...createEmptyCostUsageTotals(),
      input: 100,
      totalTokens: 100,
      totalCost: 0.5,
    };
    const selected: SessionUsageEntry = {
      key: "agent:main:known",
      updatedAt: 1,
      modelProvider: "openai",
      usage: {
        ...totals,
        computedAt: 1,
        dailyBreakdown: [{ ...totals, date: "2026-10-01", tokens: 100, cost: 0.5 }],
      },
    };
    const completeUsage = selected.usage;
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
    const request = vi.fn(async () => ({
      ...buildUsageOverview({
        rows: [selected, excluded, ...pending],
        options: {
          selectedSessions,
          query,
          limit: format === "daily-csv" ? 50 : Number.MAX_SAFE_INTEGER,
        },
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
        compact: format === "daily-csv",
      }),
      updatedAt: 1,
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 51, staleFiles: 0 },
    }));
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
        selectedSessions,
        query,
      }),
    );
    try {
      await exporter.run(format);
      expect(download).toHaveBeenCalledOnce();
      expect(toast).not.toHaveBeenCalled();
      expect(download.mock.calls[0]?.[1]).toContain("100");
      expect(download.mock.calls[0]?.[1]).toContain("0.5");
      expect(download.mock.calls[0]?.[1]).not.toContain("pending-");

      // A family can have a subtotal while another instance is still computing.
      selected.computing = true;
      await exporter.run(format);
      selected.computing = false;
      selected.usage!.staleSince = 0;
      await exporter.run(format);
      delete selected.usage!.staleSince;
      selected.usage!.refreshing = true;
      await exporter.run(format);
      selected.usage!.refreshing = false;
      selected.usage = null;
      await exporter.run(format);
      selected.usage = completeUsage;
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
    } finally {
      binding.dispose();
    }
  },
);
