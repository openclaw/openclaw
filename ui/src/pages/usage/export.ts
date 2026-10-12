import { t } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { requestSessionUsage, type SessionUsageQuery } from "../../lib/sessions/usage.ts";
import { showToast } from "../../lib/toast.ts";
import { formatIsoDate } from "./helpers.ts";
import { buildDailyCsv, buildSessionsCsv } from "./query.ts";
import { createUsageRequest } from "./request.ts";
import type { UsageJsonExport } from "./types.ts";

registerUsageEnglish();

export function createUsageExportRequest(
  notify: () => void,
  gateway: GatewayPageBinding,
  query: () => SessionUsageQuery,
) {
  return createUsageRequest(notify, {
    task: async (format: "json" | "sessions-csv" | "daily-csv", { signal }) => {
      const connection = gateway.capture();
      if (!connection) {
        throw new Error(t("common.offline"));
      }
      const selectedQuery = query();
      const result = await requestSessionUsage(
        connection.client,
        { ...selectedQuery, offset: undefined, recentKeys: undefined },
        {
          includeContextWeight: format === "json",
          ...(format === "daily-csv"
            ? { projection: "overview" as const, limit: 50 }
            : { limit: Number.MAX_SAFE_INTEGER }),
          signal,
        },
      );
      const selectedKeys = new Set(selectedQuery.selectedSessions);
      const data: UsageJsonExport = {
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
        message: `${t("usage.export.label")}: ${formatUiError(error, "request failed")}`,
      });
    },
  });
}
