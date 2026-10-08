import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSkillWorkshop = {
  skillWorkshop: {
    loadError: "Could not load the Workshop.",
    retry: "Retry",
    mode: {
      label: "Learning",
      aria: "Skill Workshop learning mode",
      off: "Off",
      auto: "Auto",
      offTitle: "The agent does not save or update skills on its own.",
      autoTitle:
        "The agent saves and improves skills as it works, announces each change, and every change can be undone.",
      updateError: "Could not update the learning mode.",
    },
    skills: {
      title: "Learned skills",
      empty: "No learned skills yet. Your agent saves skills here as it learns from its work.",
      updated: "Updated {time}",
      uses: "{count} uses",
      usesOne: "1 use",
      archived: "Archived",
    },
    changes: {
      title: "Recent changes",
      empty: "No changes yet.",
      undo: "Undo",
      undoTitle: "Restore {name} as it was before this change",
      actors: {
        agent: "Agent",
        review: "Background review",
        curator: "Cleanup",
        user: "You",
      },
      actions: {
        create: "created",
        patch: "updated",
        write_file: "updated",
        remove_file: "updated",
        archive: "archived",
        restore: "restored",
      },
    },
    viewer: {
      title: "Details",
      pick: "Select a skill to view its files and versions.",
      file: "File",
      version: "Version",
      current: "Current",
      archivedNotice: "Archived. The agent no longer sees this skill until you restore it.",
      archive: "Archive",
      restore: "Restore",
      restoreVersion: "Restore this version",
      loading: "Loading…",
    },
    learning: {
      action: "Start",
      starting: "Opening learning session\u2026",
      title: "Learn from past conversations",
      description: "Open a session where the agent looks for lessons worth saving as skills.",
      startFailed: "Could not start learning. Check your sessions before trying again.",
    },
  },
} satisfies TranslationMap;

export const registerSkillWorkshopEnglish = Object.assign(
  () => {
    Object.assign(en.skillWorkshop, enSkillWorkshop.skillWorkshop);
  },
  { catalog: enSkillWorkshop },
);
