import {
  isReservedGitHubPublicationSessionKey,
  isSystemCreatedSessionRow,
} from "../../../src/shared/session-list-visibility.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import type {
  SidebarSavedPinTime,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import type { SessionDataOwner } from "./session-data.ts";

export function projectSidebarArchiveVisibility(input: {
  sessionData: Pick<
    SessionDataOwner,
    | "childSessionRowsByParent"
    | "loadedChildSessionKeys"
    | "loadingChildSessionKeys"
    | "childSessionErrorsByParent"
  >;
  sourceRows: readonly GatewaySessionRow[];
  selectedAgentId: string;
  statusFilter: SidebarSessionStatusFilter;
  showSystem?: boolean;
  now: number;
  gatewayTimeForSavedPin?: SidebarSavedPinTime;
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
  const snoozed = (row: Pick<GatewaySessionRow, "key" | "snoozedUntil">) =>
    isSessionSnoozed(row, input.gatewayTimeForSavedPin?.(row) ?? input.now);
  const isSessionHidden = (
    row: Parameters<typeof isSystemCreatedSessionRow>[0] &
      Pick<GatewaySessionRow, "archived" | "snoozedUntil">,
  ) =>
    isLifecycleHidden(row.key) ||
    (!input.showSystem && isSystemCreatedSessionRow(row)) ||
    (input.statusFilter === "archived" && row.archived !== true) ||
    (input.statusFilter === "active" && snoozed(row)) ||
    (input.statusFilter === "snoozed" && (row.archived === true || !snoozed(row)));
  const sourceRows = input.sourceRows;
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
        : input.statusFilter === "snoozed" ||
          isLifecycleHidden(childKey) ||
          // Child windows omit publication custody rows, so their reserved key is the only evidence.
          (!input.showSystem && isReservedGitHubPublicationSessionKey(childKey))
    ) {
      return false;
    }
    // Raw lineage includes archives. Only a complete active child window can
    // establish absence; unread and failed windows retain discovery links. A
    // refresh keeps the settled window's answer until its replacement lands.
    return (
      (input.statusFilter !== "active" && input.statusFilter !== "snoozed") ||
      !input.sessionData.loadedChildSessionKeys.has(parentKey) ||
      input.sessionData.childSessionErrorsByParent.has(parentKey) ||
      input.sessionData.childSessionRowsByParent[parentKey]?.some(
        (child) => child.key === childKey,
      ) === true
    );
  };
  return { childSessionRowsByParent, isSessionHidden, isChildSessionVisible, rows };
}
