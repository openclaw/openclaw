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
      propose: "Propose",
      auto: "Auto",
      offTitle: "The agent does not save or update skills on its own.",
      proposeTitle:
        "The agent saves skill changes it would make as drafts. Review them together with /learn drafts.",
      autoTitle:
        "The agent saves and improves skills as it works, announces each change, and every change can be undone.",
      updateError: "Could not update the learning mode.",
    },
    skills: {
      title: "Learned skills",
      empty: "No learned skills yet. Your agent saves skills here as it learns from its work.",
      noneActive: "No active skills. Restore one from Archived, or let the agent learn.",
      noneArchived: "Nothing archived.",
      noneDrafts:
        "No drafts waiting. In Propose mode, background reviews save the skill changes they would make here for you to apply or discard.",
      filterAria: "Show active or archived skills",
      active: "Active",
      uses: "{count} uses",
      usesOne: "1 use",
      noUses: "Not used yet",
      archived: "Archived",
      archivedAgo: "Archived {time}",
      drafts: "Drafts",
    },
    drafts: {
      newSkill: "New skill",
      update: "Update",
      proposed: "Proposed {time}",
      createsSkill: "Creates a new skill",
      updatesSkill: "Changes the live skill",
      files: "{count} files",
      apply: "Apply",
      applyNewTitle: "Create this skill. You can archive it later.",
      applyUpdateTitle:
        "Replace the live skill with this draft. The current version is saved first, so you can undo.",
      discard: "Discard",
      discardTitle: "Delete this draft. No skill changes.",
      diffLive: "Live skill",
      diffDraft: "Draft",
      same: "This draft already matches the live skill. Discard it.",
      tooLarge: "This draft differs too much from the live skill to compare line by line.",
      filesLabel: "Files",
      chatHint:
        "Want the agent's judgment first? Send /learn drafts in chat to review all drafts together, or /learn drafts {skill} for this skill only.",
    },
    sort: {
      label: "Sort skills",
      uses: "Most used",
      recent: "Recently active",
      name: "Name",
    },
    unused: {
      badge: "Unused {days}d",
      title: "Unused-skill cleanup can archive learned skills after {days} idle days.",
      notice:
        "Unused for {days} days. Unused-skill cleanup can archive learned skills after {limit} idle days on agents where it runs; using the skill resets the clock.",
    },
    tabs: {
      aria: "Skill sections",
      instructions: "Instructions",
      files: "Files",
      history: "History",
    },
    changes: {
      empty: "No changes yet.",
      undo: "Undo",
      undoTitle: "Restore {name} as it was before this change",
      restoreBefore: "Restore before",
      compare: "Compare",
      compareTitle: "Show how the skill read before this change",
      view: "View",
      savedBefore: "Saved before it was {action}",
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
      pick: "Select a skill to view it.",
      pickFile: "Select a file.",
      noFiles: "This skill has no support files. Scripts, templates, and references appear here.",
      lastUsed: "last used {time}",
      createdBy: "created by {actor}",
      versions: "{count} saved versions",
      versionsOne: "1 saved version",
      viewingVersion: "Viewing the version from {time}",
      diffHint: "changes since then",
      diffCurrent: "Today",
      diffVersion: "Before",
      noDiff: "This version matches today's instructions.",
      diffTooLarge: "This version is too different from today's to compare line by line.",
      backToCurrent: "Back to current",
      archivedNotice: "Archived. The agent no longer sees this skill until you restore it.",
      archive: "Archive",
      archiveTitle: "Hide this skill from the agent. You can restore it any time.",
      restore: "Restore",
      restoreVersion: "Restore this version",
      loading: "Loading…",
    },
    learning: {
      short: "Learn from history",
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
