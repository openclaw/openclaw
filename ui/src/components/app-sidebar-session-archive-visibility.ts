import type { GatewaySessionRow } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export function projectSidebarArchiveVisibility(input: {
  sessionData: Pick<
    SessionDataController,
    "childSessionRowsByParent" | "sessionResultsByAgent" | "sessionsAgentId" | "sessionsResult"
  >;
  selectedAgentId: string;
  statusFilter: SidebarSessionStatusFilter;
  deletionState: SessionCapability["deletionState"];
  archiveVisibility: SessionCapability["archiveVisibility"];
}) {
  const isSessionHidden = (row: Pick<GatewaySessionRow, "key" | "archived">) => {
    const visibility = input.archiveVisibility(row.key);
    return (
      input.deletionState(row.key, input.selectedAgentId) ||
      visibility === "pending" ||
      (input.statusFilter === "active" && visibility === "archived") ||
      (input.statusFilter === "archived" && row.archived !== true)
    );
  };
  const selectedAgentId = normalizeAgentId(input.selectedAgentId);
  const rows = (
    selectedAgentId === normalizeAgentId(input.sessionData.sessionsAgentId ?? "")
      ? (input.sessionData.sessionsResult?.sessions ?? [])
      : (input.sessionData.sessionResultsByAgent[selectedAgentId]?.sessions ?? [])
  ).filter((row) => !isSessionHidden(row));
  const childSessionRowsByParent = Object.fromEntries(
    Object.entries(input.sessionData.childSessionRowsByParent).map(([parentKey, childRows]) => [
      parentKey,
      childRows.filter((row) => !isSessionHidden(row)),
    ]),
  );
  return { childSessionRowsByParent, isSessionHidden, rows };
}
