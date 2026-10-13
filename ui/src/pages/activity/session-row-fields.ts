import type {
  ProjectedSessionRow,
  SessionRowField,
} from "../../lib/sessions/session-row-fields.ts";

export const CURRENT_WORK_ROW_FIELDS = [
  "agentId",
  "label",
  "displayName",
  "derivedTitle",
  "accountId",
  "boardFace",
  "worktree",
  "repository",
  "execNode",
  "status",
  "hasActiveRun",
  "activeRunIds",
  "snapshotAt",
  "startedAt",
  "pinned",
  "pinnedAt",
  "isDock",
  "childSessions",
  "spawnedBy",
  "controlOwnerSessionKey",
  "parentSessionKey",
] as const satisfies readonly SessionRowField[];

export const ACTIVITY_HISTORY_ROW_FIELDS = [
  ...CURRENT_WORK_ROW_FIELDS,
  "execCwd",
  "sessionRoot",
  "spawnedWorkspaceDir",
  "spawnedCwd",
  "permissionMode",
  "permissionModePending",
  "owner",
  "createdActor",
  "createdVia",
  "createdAt",
  "channel",
  "hasAutomation",
  "observerDigest",
  "activitySummary",
  "lastActivityAt",
  "lastInteractionAt",
  "archived",
  "sidebarRoot",
] as const satisfies readonly SessionRowField[];

export type CurrentWorkRow = ProjectedSessionRow<typeof CURRENT_WORK_ROW_FIELDS>;
export type ActivityHistoryRow = ProjectedSessionRow<typeof ACTIVITY_HISTORY_ROW_FIELDS>;
