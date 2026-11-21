import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    composer: {
      workspaceRestoreSnapshotDetail:
        "Restore the saved workspace, including uncommitted changes, before sending a message.",
      workspaceRestoreFreshDetail:
        "No saved snapshot is available. Restore a fresh checkout of the recorded branch before sending a message.",
      workspaceRestore: "Restore",
      workspaceRestoreFresh: "Restore fresh checkout",
      workspaceRestoring: "Restoring workspace…",
      workspaceRestoreHelp:
        "Retry Restore, ask an administrator for help, or start a new conversation.",
    },
  },
} satisfies TranslationMap;

export const registerChatWorktreeEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
