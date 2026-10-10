import type { GatewaySessionRow } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import type { SidebarSessionStatusFilter } from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export function projectSidebarArchiveVisibility(input: {
  sessionData: Pick<
    SessionDataController,
    | "childSessionRowsByParent"
    | "loadedChildSessionKeys"
    | "loadingChildSessionKeys"
    | "childSessionErrorsByParent"
    | "sessionResultsByAgent"
    | "sessionsAgentId"
    | "sessionsResult"
  >;
  selectedAgentId: string;
  statusFilter: SidebarSessionStatusFilter;
  now: number;
  deletionState: SessionCapability["deletionState"];
  archiveVisibility: SessionCapability["archiveVisibility"];
}) {
  const isLifecycleHidden = (key: string): boolean => {
    const visibility = input.archiveVisibility(key);
    return (
      Boolean(input.deletionState(key, input.selectedAgentId)) ||
      visibility === "pending" ||
      ((input.statusFilter === "active" || input.statusFilter === "snoozed") &&
        visibility === "archived")
    );
  };
  const isSessionHidden = (row: Pick<GatewaySessionRow, "key" | "archived" | "snoozedUntil">) =>
    isLifecycleHidden(row.key) ||
    (input.statusFilter === "archived" && row.archived !== true) ||
    (input.statusFilter === "active" && isSessionSnoozed(row, input.now)) ||
    (input.statusFilter === "snoozed" &&
      (row.archived === true || !isSessionSnoozed(row, input.now)));
  const selectedAgentId = normalizeAgentId(input.selectedAgentId);
  const sourceRows =
    selectedAgentId === normalizeAgentId(input.sessionData.sessionsAgentId ?? "")
      ? (input.sessionData.sessionsResult?.sessions ?? [])
      : (input.sessionData.sessionResultsByAgent[selectedAgentId]?.sessions ?? []);
  const knownRows = new Map(
    [...Object.values(input.sessionData.childSessionRowsByParent).flat(), ...sourceRows].map(
      (row) => [row.key, row],
    ),
  );
  const rows = sourceRows.filter((row) => !isSessionHidden(row));
  const childSessionRowsByParent = Object.fromEntries(
    Object.entries(input.sessionData.childSessionRowsByParent).map(([parentKey, childRows]) => [
      parentKey,
      childRows.filter((row) => !isSessionHidden(row)),
    ]),
  );
  const isChildSessionVisible = (parentKey: string, childKey: string, row?: GatewaySessionRow) => {
    const known = row ?? knownRows.get(childKey);
    if (
      known
        ? isSessionHidden(known)
        : input.statusFilter === "snoozed" || isLifecycleHidden(childKey)
    ) {
      return false;
    }
    // Raw lineage includes archives. Only a complete active child window can
    // establish absence; pending/failed reads must retain discovery links.
    return (
      (input.statusFilter !== "active" && input.statusFilter !== "snoozed") ||
      !input.sessionData.loadedChildSessionKeys.has(parentKey) ||
      input.sessionData.loadingChildSessionKeys.has(parentKey) ||
      input.sessionData.childSessionErrorsByParent.has(parentKey) ||
      input.sessionData.childSessionRowsByParent[parentKey]?.some(
        (child) => child.key === childKey,
      ) === true
    );
  };
  return { childSessionRowsByParent, isSessionHidden, isChildSessionVisible, rows };
}
