import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionOrganizationShared = {
  sessionsView: {
    personalGroupAdd: "Add to section",
    personalGroupReferenceAdded: "Added to section. Sessions stay in their groups.",
    personalGroups: "Sections",
    personalGroupNew: "New section",
    personalGroupEmpty: "Drag sessions here or choose Edit section to add them.",
    personalGroupOptions: "Options for section {group}",
    personalGroupEditMenu: "Edit section",
    personalGroupMoveUp: "Move up",
    personalGroupMoveDown: "Move down",
    personalGroupRemove: "Remove section",
    personalGroupRemoved: "Section removed. Sessions are unchanged.",
    personalGroupUnavailable: "Connection changed. Reopen the section to edit it.",
    personalGroupChanged: "This section changed. Reopen it before saving your edits.",
    personalGroupCapacity:
      "Sections are full. Remove a section or remove some sessions from sections before adding more.",
    title: "Sessions",
    subtitle: "Browse sessions and manage per-session overrides.",
    archivedOnlyTooltip: "Show only archived sessions.",
    archiveReasonManual: "Archived manually",
    archiveReasonAgeRetention: "Automatically archived by age retention",
    archiveReasonActiveSessionCap:
      "Automatically archived because the active-session limit was reached",
    archiveReasonStaleDashboard: "Automatically archived after dashboard inactivity",
    archiveReasonRestartRecovery: "Archived when a replacement session was recovered",
    goal: "Goal",
    pinRootSessionsOnly: "Only root sessions can be pinned; pin the parent session instead.",
    copyTranscriptChanged: "Conversation changed while copying. Try again.",
    openWindowBlocked: "Allow pop-ups for this site, then try again.",
    splitUnavailable: "Open a conversation on a wide screen to use split view.",
    moveSession: "Move session…",
    moveSessionTitle: "Move session",
    moveSessionFailed: "Move failed",
    moveSessionGatewayTarget: "Gateway",
    movingSession: "Moving to {target}…",
    movingSessionGeneric: "Moving session…",
    stopCloudWorker: "Stop cloud worker…",
    stopCloudWorkerConfirm: 'Stop the cloud worker for "{session}"?',
    stopCloudWorkerConfirmAction: "Stop worker",
    deleteSessionStale: 'Gateway connection replaced before "{session}" was deleted. Try again.',
    newGroupPrompt: "New group name",
    newGroupTitle: "New group",
    newGroupCreate: "Create group",
    newGroupFailed: "Could not create the group.",
    newGroupStale: "Gateway connection replaced before the group was saved. Try again.",
  },
  worktrees: {
    title: "Managed Worktrees",
    subtitle: "Isolated repository checkouts owned by OpenClaw.",
  },
} satisfies TranslationMap;

export const registerSessionOrganizationSharedEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionOrganizationShared.sessionsView);
    Object.assign(en.worktrees, enSessionOrganizationShared.worktrees);
  },
  { catalog: enSessionOrganizationShared },
);
