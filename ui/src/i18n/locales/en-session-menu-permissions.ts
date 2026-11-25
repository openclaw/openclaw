import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  sessionsView: {
    renamePermissionDenied: "You don’t have permission to rename this session.",
    iconPermissionDenied: "You don’t have permission to change this session’s icon.",
    colorPermissionDenied: "You don’t have permission to change this session’s color.",
    communicationPermissionDenied:
      "You don’t have permission to change this session’s communication settings.",
    promotePermissionDenied: "You don’t have permission to move this session to the top level.",
    readStatusPermissionDenied: "You don’t have permission to change the read status.",
    involvementPermissionDenied:
      "You don’t have permission to change whether this session involves you.",
    moveGroupPermissionDenied: "You don’t have permission to move sessions to a group.",
    createGroupPermissionDenied: "You don’t have permission to create a group.",
    archivePermissionDenied: "You don’t have permission to archive this session.",
    restorePermissionDenied: "You don’t have permission to restore this session.",
    archiveBatchPermissionDenied: "You don’t have permission to archive these sessions.",
    restoreBatchPermissionDenied: "You don’t have permission to restore these sessions.",
    snoozePermissionDenied: "You don’t have permission to snooze this session.",
    wakePermissionDenied: "You don’t have permission to wake this session.",
    deletePermissionDenied: "You don’t have permission to delete this session.",
    deleteBatchPermissionDenied: "You don’t have permission to delete these sessions.",
    forkPermissionDenied:
      "You don’t have permission to fork this session or create a child session.",
    stopWorkerPermissionDenied: "You don’t have permission to stop this session on its device.",
    assignPermissionDenied: "You don’t have permission to assign this session.",
  },
} satisfies TranslationMap;

export const registerSessionMenuPermissionsEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, catalog.sessionsView);
  },
  { catalog },
);
