import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// External-session actions load with the menu; chat and original-link copy stay eager.
const enCatalogMenu = {
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
      deleteSessionConfirm:
        "Delete this external session from OpenClaw? Make sure no other runner is using it. Beamed sessions are deleted permanently. Sessions kept by another tool, such as Codex, are archived there and may be restorable.",
      terminalUnavailable: "Terminal opening is unavailable for this session.",
    },
  },
} satisfies TranslationMap;

export const registerCatalogMenuEnglish = Object.assign(
  () => Object.assign(en.chat.catalog, enCatalogMenu.chat.catalog),
  { catalog: enCatalogMenu },
);
