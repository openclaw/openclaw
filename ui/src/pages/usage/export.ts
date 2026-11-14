import { t } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import {
  buildSessionUsageDateParams,
  requestSessionUsage,
  type SessionUsageQuery,
} from "../../lib/sessions/usage.ts";
import { showToast } from "../../lib/toast.ts";
import { isUsageCacheIncomplete } from "./cache-status.ts";
import { formatIsoDate } from "./helpers.ts";
import { buildDailyCsv, buildSessionsCsv } from "./query.ts";
import type { UsageJsonExport } from "./usage-state-types.ts";

registerUsageEnglish();

export function createUsageExportRequest(
  notify: () => void,
  gateway: GatewayPageBinding,
  query: () => SessionUsageQuery,
) {
  return createPageRequest(notify, {
    task: async (format: "json" | "sessions-csv" | "daily-csv", { signal }) => {
      const connection = gateway.capture();
      if (!connection) {
        throw new Error(t("common.offline"));
      }
      const currentQuery = query();
      const selectedQuery = {
        ...currentQuery,
        selectedDays: [...(currentQuery.selectedDays ?? [])],
        selectedHours: [...(currentQuery.selectedHours ?? [])],
        selectedSessions: [...(currentQuery.selectedSessions ?? [])],
      };
      const dateParams = buildSessionUsageDateParams(selectedQuery.timeZone);
      const result = await requestSessionUsage(
        connection.client,
        { ...selectedQuery, offset: undefined, recentKeys: undefined },
        {
          includeContextWeight: format === "json",
          ...(format === "daily-csv"
            ? { projection: "overview" as const, limit: 50 }
            : { limit: Number.MAX_SAFE_INTEGER }),
          signal,
          dateParams,
        },
      );
      if (
        isUsageCacheIncomplete(result.cacheStatus, undefined) &&
        result.overview?.selectedUsageComplete !== true
      ) {
        throw new Error(t("usage.export.incomplete"));
      }
      const selectedKeys = new Set(selectedQuery.selectedSessions);
      const data: UsageJsonExport = {
        context: {
          version: 1,
          generatedAt: new Date().toISOString(),
          startDate: selectedQuery.startDate,
          endDate: selectedQuery.endDate,
          timeZone: { selection: selectedQuery.timeZone, ...dateParams },
          agentId: selectedQuery.agentId || null,
          groupBy: selectedQuery.scope,
          creatorKey: selectedQuery.creatorKey || null,
          query: selectedQuery.query || null,
          selectedDays: selectedQuery.selectedDays,
          selectedHours: selectedQuery.selectedHours,
          selectedSessions: selectedQuery.selectedSessions,
        },
        sessions: selectedKeys.size
          ? result.sessions.filter((session) => selectedKeys.has(session.key))
          : result.sessions,
        totals: result.totals,
        aggregates: result.aggregates,
        daily: result.aggregates.costDaily ?? [],
      };
      return { connection, data, format };
    },
    onComplete: ({ connection, data, format }) => {
      if (!gateway.isCurrent(connection)) {
        return;
      }
      const stamp = formatIsoDate(new Date());
      if (format === "json") {
        downloadTextFile(
          `openclaw-usage-${stamp}.json`,
          JSON.stringify(data, null, 2),
          "application/json;charset=utf-8",
        );
      } else {
        const kind = format === "sessions-csv" ? "sessions" : "daily";
        downloadTextFile(
          `openclaw-usage-${kind}-${stamp}.csv`,
          kind === "sessions" ? buildSessionsCsv(data.sessions) : buildDailyCsv(data.daily),
          "text/csv;charset=utf-8",
        );
      }
    },
    onError: (error) => {
      showToast({
        severity: "error",
        message: `${t("usage.export.label")}: ${formatUiError(error, "request failed")}`,
      });
    },
  });
}
