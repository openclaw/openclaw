import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionOrganization = {
  sessionsView: {
    groupDefaultsTitle: 'New session defaults for "{group}"',
    groupDefaultsCwd: "Working directory",
    groupDefaultsCwdPlaceholder: "Use the agent workspace",
    groupDefaultsMode: "Environment",
    groupDefaultsLocal: "Current checkout",
    groupDefaultsWorktree: "New worktree",
    groupDefaultsDescription: "Choose where new sessions in this group start.",
    groupDefaultsCwdHint: "Leave empty to use the selected agent's workspace.",
    groupDefaultsWorktreeHint: "Runs each session in an isolated Git worktree.",
    groupDefaultsRequiresAdmin:
      "This folder is outside agent workspaces. Saving defaults for it requires operator.admin. Open Inbox, select Limited access, request admin, then approve in Devices.",
    sessionSnoozed: "Snoozed until {time}",
    sessionsArchived: "Archived {count} sessions",
    renameSessionPrompt: "Rename session",
    sessionNameInUse: "A session with this name already exists.",
    newGroupMoveSkipped:
      "Group created, but the move was skipped because the list changed. Move from the row menu.",
    stopCloudWorkerConfirm: 'Stop the cloud worker for "{session}"?',
    stopCloudWorkerConfirmAction: "Stop worker",
    stopCloudWorkerStale:
      'Gateway connection replaced before the cloud worker for "{session}" was stopped. Try again.',
    deleteSessionConfirm:
      'Delete "{session}" and its transcript? Any attached worker will be stopped safely first.',
    deleteSessionsConfirm:
      "Delete {count} sessions and their transcripts? Any attached workers will be stopped safely first.",
    deleteSelectedConfirmOne:
      "Delete 1 session?\n\nStop any attached worker safely, then delete the session entry and archive its transcript.",
    deleteSelectedConfirm:
      "Delete {count} sessions?\n\nStop any attached workers safely, then delete the session entries and archive their transcripts.",
    archiveSessionTree: "Archive session and children…",
    moveToTopLevel: "Move to top level",
    archiveTreeRootRequired:
      "Archive a persistent conversation and its children, not a hidden worker run.",
    archiveSessionTreeConfirm:
      "Archive {count} sessions, including {session}? Sessions moved to the top level or a group are not included.",
    archiveRunningSessions:
      "This selection contains active work. Archiving stops work in the selected sessions.",
    archiveRunningSessionConfirm:
      "Archive {session}? Active work in this session will be stopped. Other conversations are not archived.",
    archiveTreeChanged:
      "The session tree changed. Nothing was archived. Open the menu and try again.",
    sessionMovedToTopLevel: "Session moved to top level",
  },
} satisfies TranslationMap;

export const registerSessionOrganizationEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionOrganization.sessionsView);
  },
  { catalog: enSessionOrganization },
);
