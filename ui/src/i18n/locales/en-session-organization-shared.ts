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
    transcriptSearchArchivedExcluded:
      "{count} archived transcripts excluded; open a session to restore its searchable history.",
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
    splitUnavailable: "Open a session on a wide screen to use split view.",
    moveSession: "Move session…",
    moveSessionTitle: "Move session",
    moveSessionFailed: "Couldn’t move this session. Try again.",
    moveSessionGatewayTarget: "Gateway",
    movingSession: "Moving to {target}…",
    movingSessionGeneric: "Moving session…",
    stopWorker: "Stop session on device…",
    stopWorkerConfirm: "Stop “{session}” on its device?",
    stopWorkerDescription:
      "This session stops working on its device after saving workspace changes. Your conversation and saved changes stay.",
    stopWorkerConfirmAction: "Stop",
    stopCloudWorker: "Stop cloud device…",
    stopCloudWorkerConfirm: "Stop this cloud device?",
    stopCloudWorkerTarget: "Session: {session}",
    stopCloudWorkerDescription:
      "The session stops working on it and the cloud device is released. Your conversation and accepted changes stay.",
    lifecycleIdentityRequired: "This action needs a saved session.",
    stopCloudWorkerConfirmAction: "Stop",
    deleteSessionStale: "The connection changed before “{session}” was deleted. Try again.",
    newGroupPrompt: "New group name",
    newGroupTitle: en.sessionsView.newGroupTitle,
    newGroupCreate: "Create group",
    newGroupFailed: "Couldn’t create the group. Try again.",
    newGroupStale: "The connection changed before the group was saved. Try again.",
  },
  worktrees: {
    title: "Managed worktrees",
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
