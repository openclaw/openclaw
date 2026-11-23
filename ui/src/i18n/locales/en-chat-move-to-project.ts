import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    sessionHeader: {
      moveToProject: {
        action: "Move to project…",
        title: "Move to a project",
        project: "Project",
        move: "Move",
        moving: "Moving…",
        noProjects:
          "No projects are available to move into. An admin can register a project from Browse folders.",
        copySavedWork: "Your saved work will be copied.",
        copyOneFile: "Changes to 1 file will be copied.",
        copyFiles: "Changes to {count} files will be copied.",
        moved: "Moved this conversation into {project}.",
        movedWithWork:
          "Moved this conversation into {project}. Your changes were copied to its checkout.",
        failed: "Couldn’t move this conversation. Try again.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatMoveToProjectEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
