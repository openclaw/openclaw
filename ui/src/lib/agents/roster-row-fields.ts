import type { ProjectedSessionRow, SessionRowField } from "../sessions/session-row-fields.ts";

export const AGENT_ROSTER_ROW_FIELDS = [
  "agentId",
  "isMain",
  "hasActiveRun",
  "status",
  "unread",
  "archived",
  "lastMessagePreview",
  "owner",
  "createdActor",
  "pinned",
  "pinnedAt",
  "isDock",
  "sidebarRoot",
  "spawnedBy",
  "controlOwnerSessionKey",
  "parentSessionKey",
  "childSessions",
  "snapshotAt",
  "startedAt",
] as const satisfies readonly SessionRowField[];

export type AgentRosterSessionRow = ProjectedSessionRow<typeof AGENT_ROSTER_ROW_FIELDS>;
