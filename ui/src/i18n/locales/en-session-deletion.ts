import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionDeletion = {
  sessionsView: {
    deleteSessionTitle: "Delete “{session}”?",
    deleteSessionConfirm:
      "This deletes the session entry but keeps an archived copy of its chat history. Work on any attached device stops first.",
    deleteSessionsTitle: "Delete {count} sessions?",
    deleteSessionsConfirm:
      "This deletes the session entries but keeps archived copies of their chat history. Work on any attached devices stops first.",
    deleteIncognitoSessionConfirm:
      "This deletes the incognito session and its chat history without an archive. Work on any attached device stops first.",
    deleteIncognitoSessionsConfirm:
      "This deletes the incognito sessions and their chat history without an archive. Work on any attached devices stops first.",
    deleteMixedSessionsConfirm:
      "This deletes the session entries. Regular chat history is archived; incognito chat history is deleted without an archive. Work on any attached devices stops first.",
  },
} satisfies TranslationMap;

export const registerSessionDeletionEnglish = Object.assign(
  () => Object.assign(en.sessionsView, enSessionDeletion.sessionsView),
  { catalog: enSessionDeletion },
);
