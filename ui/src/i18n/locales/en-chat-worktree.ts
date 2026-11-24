import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    composer: {
      workspaceRestoreSnapshotDetail: "Restore this conversation’s workspace to send a message.",
      workspaceRestoreFreshDetail:
        "No saved workspace is available. Restore a fresh checkout to send a message.",
      workspaceRestore: "Restore workspace",
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
