import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { registerSessionNavigationEnglish } from "./en-session-navigation.ts";
import { en } from "./en.ts";

// External-session actions load with the sidebar menu, not session navigation.
const catalog = {
  chat: {
    catalog: {
      sessionMenu: "External session actions",
      openInOpenClaw: "Open in OpenClaw",
      importToOpenClaw: "Import to OpenClaw",
      importComplete: "Imported {count} transcript items.",
      importUnchanged: "The imported transcript is up to date.",
      importIncomplete:
        "Imported {count} transcript items. Older history exceeded the import limit.",
      openImportedSession: "Open imported session",
      openInTerminal: "Open in terminal",
      deleteSession: "Delete",
      deleteSessionTitle: "Delete this external session?",
      deleteSessionConfirm:
        "Make sure it isn’t in use elsewhere. Beamed sessions are deleted permanently. Sessions kept by another tool, such as Codex, are archived there and may be restorable.",
      terminalUnavailable: "Terminal opening is unavailable for this session.",
    },
  },
} satisfies TranslationMap;

export const registerSessionCatalogMenuEnglish = Object.assign(
  () => {
    registerSessionNavigationEnglish();
    mergeCatalog(en.chat.catalog, catalog.chat.catalog);
  },
  { catalog },
);
