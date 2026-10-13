import type {
  ProjectedSessionRow,
  SessionRowField,
} from "../../lib/sessions/session-row-fields.ts";

export const DASHBOARD_ROW_FIELDS = [
  "agentId",
  "label",
  "displayName",
  "derivedTitle",
  "lastMessagePreview",
  "accountId",
  "snapshotAt",
  "status",
  "createdActor",
  "owner",
  "hasBoard",
  "boardFace",
  "archived",
  "pinned",
  "pinnedAt",
  "isDock",
  "sidebarRoot",
  "spawnedBy",
  "controlOwnerSessionKey",
  "parentSessionKey",
  "childSessions",
  "worktree",
  "repository",
  "execNode",
] as const satisfies readonly SessionRowField[];

export type DashboardRow = ProjectedSessionRow<typeof DASHBOARD_ROW_FIELDS>;
