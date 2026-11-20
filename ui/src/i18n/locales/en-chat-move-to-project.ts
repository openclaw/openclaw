import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    sessionHeader: {
      moveToProject: {
        action: "Move to project…",
        title: "Move to a project",
        move: "Move",
        moving: "Moving… this can take a minute",
        noProjects:
          "No projects are available to move into. An admin can register a project from Browse folders.",
        checkoutPreview:
          "Carry work from {folder} at commit {commit}. Files with unsaved changes: {unsavedFiles}.",
        moved: "Moved into {project}. It opens on its own branch with your next message.",
        movedWithWork:
          "Moved into {project} with your work from {folder}. It opens on its own branch with your next message.",
        failed: "Couldn’t move this conversation. Try again.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatMoveToProjectEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
