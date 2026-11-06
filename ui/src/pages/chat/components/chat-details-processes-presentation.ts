import { createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import type { ChatDetailsSnapshot } from "../session-details-snapshot-schema.ts";
import { hasDetailsProcesses } from "./chat-details-content.ts";

/** Details previews live work; the complete process collection retains history. */
export function createDetailsProcessesPresentation(rows: () => readonly SessionProcessSummary[]) {
  return createMemo(() => rows().filter((row) => row.status === "running"));
}

/** The real process owner retires cached rows on a result or access denial. */
export function readDetailsProcesses(
  snapshot: Pick<ProcessesPanelData["snapshot"], "rows" | "hasResult" | "errorKind"> | undefined,
  cached: ChatDetailsSnapshot["processes"],
) {
  const live = (snapshot?.rows ?? []).filter((row) => row.status === "running");
  const rows =
    snapshot?.hasResult || snapshot?.errorKind === "access"
      ? live.slice(0, 3)
      : (cached?.rows ?? []).map(({ processId, instanceId, name }) => ({
          processId,
          instanceId,
          name,
          canStop: false,
        }));
  return {
    live,
    rows,
    hidden: (snapshot?.hasResult ? live.length : (cached?.total ?? 0)) - rows.length,
    available: hasDetailsProcesses(snapshot, cached),
  };
}
