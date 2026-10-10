import { t } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { requestSessionUsage, type SessionUsageQuery } from "../../lib/sessions/usage.ts";
import { showToast } from "../../lib/toast.ts";
import { formatIsoDate } from "./helpers.ts";
import { createUsageRequest } from "./request.ts";
import type { UsageJsonExport, UsageSessionEntry } from "./types.ts";

registerUsageEnglish();

// Logical keys can be reused after deletion; context belongs to a concrete session.
function sessionIdentity({ agentId, key, sessionId }: UsageSessionEntry): string {
  return JSON.stringify([agentId, key, sessionId]);
}

export function createUsageJsonExportRequest(
  notify: () => void,
  gateway: GatewayPageBinding,
  query: () => SessionUsageQuery,
) {
  return createUsageRequest(notify, {
    task: async (data: UsageJsonExport, { signal }) => {
      const connection = gateway.capture();
      if (!connection) {
        throw new Error(t("common.offline"));
      }
      const filename = `openclaw-usage-${formatIsoDate(new Date())}.json`;
      let weights = new Map<string, UsageSessionEntry["contextWeight"]>();
      if (data.sessions.some((session) => session.hasContextWeight)) {
        const result = await requestSessionUsage(connection.client, query(), {
          includeContextWeight: true,
          signal,
        });
        weights = new Map(
          result.sessions.map((session) => [sessionIdentity(session), session.contextWeight]),
        );
        if (
          data.sessions.some(
            (session) => session.hasContextWeight && !weights.get(sessionIdentity(session)),
          )
        ) {
          throw new Error(t("usage.export.changed"));
        }
      }
      // Export the clicked snapshot's totals and rows; only hydrate their omitted details.
      const hydratedData = {
        ...data,
        sessions: data.sessions.map((session) => ({
          ...session,
          contextWeight: weights.get(sessionIdentity(session)) ?? null,
        })),
      };
      return { connection, filename, data: hydratedData };
    },
    onComplete: ({ connection, filename, data }) => {
      if (gateway.isCurrent(connection)) {
        downloadTextFile(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
      }
    },
    onError: (error) => {
      showToast({
        message: `${t("usage.export.label")}: ${formatUiError(error, "request failed")}`,
      });
    },
  });
}
