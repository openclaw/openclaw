import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  compareSessionRowsByUpdatedAt,
  filterVisibleSessionRows,
} from "../lib/sessions/navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";

/** Resolve the destination when the switcher menu is used, not when the chip is displayed. */
export function resolveAgentMenuSessionKey(input: {
  agentId: string;
  result: SessionsListResult | null;
  mainKey: string;
  context: ApplicationContext | undefined;
}): string {
  const normalized = normalizeAgentId(input.agentId);
  // Unprefixed keys belong to the system default agent. Keeping them for
  // another agent would resume the wrong conversation with the raw key.
  const visible = filterVisibleSessionRows(input.result?.sessions ?? [], {
    agentId: normalized,
    defaultAgentId: resolveUiDefaultAgentId({
      agentsList: input.context?.agents.state.agentsList,
      hello: input.context?.gateway.snapshot.hello,
    }),
    filterByAgent: true,
    archivedFilter: "active",
  });
  const latest = visible.reduce<SessionsListResult["sessions"][number] | null>(
    (current, row) =>
      current !== null && compareSessionRowsByUpdatedAt(current, row) <= 0 ? current : row,
    null,
  );
  return (
    latest?.key ?? buildAgentMainSessionKey({ agentId: input.agentId, mainKey: input.mainKey })
  );
}
