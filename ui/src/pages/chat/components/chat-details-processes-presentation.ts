import { createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { projectTheme } from "../../../lib/reactive/theme.ts";

type DetailsProcesses = {
  sessionKey: string;
  agentId: string;
  rows: readonly SessionProcessSummary[];
};

/** Details alone applies the viewer's preference; the process collection stays complete. */
export function createDetailsProcessesPresentation(source: () => DetailsProcesses) {
  const context = useOptionalApplication();
  const gateway = context ? projectGateway(context.gateway) : undefined;
  const preferences = context ? projectTheme(context.theme).preferences : undefined;
  const dismissalKey = () => {
    const viewer = gateway?.read().snapshot.selfUser;
    // An unresolved viewer must never read or write the profileless preference.
    return viewer === undefined
      ? undefined
      : JSON.stringify([viewer?.id ?? null, source().agentId, source().sessionKey]);
  };
  const rows = createMemo(() => {
    const key = dismissalKey();
    const dismissed = key ? (preferences?.read().detailsDismissedProcesses?.[key] ?? []) : [];
    return source().rows.filter(
      (row) => row.status !== "completed" || !dismissed.includes(row.instanceId),
    );
  });
  return {
    rows,
    ready: () => dismissalKey() !== undefined,
    dismiss(row: SessionProcessSummary) {
      const key = dismissalKey();
      if (!context || !key || row.status !== "completed") {
        return;
      }
      const gatewayUrl = context.gateway.connection.gatewayUrl;
      const stored = loadSettings(gatewayUrl).detailsDismissedProcesses ?? {};
      patchSettings(
        {
          gatewayUrl,
          detailsDismissedProcesses: {
            ...stored,
            [key]: [...new Set([...(stored[key] ?? []), row.instanceId])],
          },
        },
        { selectGateway: false },
      );
    },
  };
}
