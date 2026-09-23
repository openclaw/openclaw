import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSkillWorkshop = {
  skillWorkshop: {
    title: "Skill Workshop",
    header: {
      selfLearning: "Self-learning",
      selfLearningAria: "Toggle autonomous self-learning",
      weeklyReviewsPaused: "Weekly reviews paused. Enable cron in Automation settings.",
      selfLearningTooltip:
        "Capture corrections and review completed work as reusable skills. Automatic mode applies scanner-approved captures to Skills.",
    },
    sections: {
      aria: "Workshop sections",
      skills: "Skills",
      suggestions: "Suggestions",
    },
    collection: {
      search: "Search installed skills\u2026",
      searchLabel: "Search installed skills",
      refresh: "Refresh skills",
      shelfLabel: "Installed skills",
      count: "{count} installed",
      countOne: "1 installed",
      countFiltered: "{shown} of {total} installed",
      countUnavailable: "Count unavailable",
      loading: "Loading installed skills\u2026",
      loadingSkill: "Loading {name}\u2026",
      errorTitle: "Could not load installed skills",
      errorBody: "Try again to reload the list.",
      readErrorTitle: "Could not open {name}",
      emptyTitle: "No skills installed yet",
      emptyBody: "Apply a suggestion and it appears here as an installed skill.",
      seeSuggestions: "See suggestions",
      noMatchTitle: "No skills match that search",
      noMatchBody: "Clear the search or try another word.",
      clearSearch: "Clear search",
      pickTitle: "Pick a skill",
      pickBody: "Select a skill to see its instructions or changes.",
      changes: "Instruction changes",
      savedOn: "Changes since {date}",
      changedSince: "Changed since {date}",
      noChanges: "No instruction changes",
      savedVersion: "Saved version → current",
      savedNote:
        "Compares saved instructions with the installed skill. Intermediate edits and supporting files are not shown.",
      noSavedVersion: "No saved version is available to compare with this skill.",
      savedVersionError: "Could not load saved versions. Refresh to try again.",
      comparing: "Comparing saved instructions…",
      unchanged: "The instructions match this saved version.",
    },
    recency: {
      today: "Today",
      yesterday: "Yesterday",
      earlier: "Earlier",
    },
    previewContext: "in {slug}",
    actions: {
      close: "Close",
      cancel: "Cancel",
      previous: "Previous",
      next: "Next",
      apply: "Apply",
      applying: "Applying\u2026",
      evaluate: "Evaluate",
      evaluating: "Evaluating\u2026",
      evaluated: "Evaluated",
      revise: "Revise",
      opening: "Opening\u2026",
      reject: "Reject",
      rejecting: "Rejecting\u2026",
      sending: "Sending\u2026",
    },
    notices: {
      applied: "Applied",
      confirmUnconfirmed:
        "The proposal status did not confirm as expected after the action. Refresh the workshop and check before retrying.",
      proposalChanged:
        "Suggestion changed. Review the updated draft before choosing another action.",
      rejected: "Rejected",
      revisionRequested: "Revision requested",
    },
    revision: {
      title: "{verb} suggestion",
      description:
        "Tell the agent what should change. The suggestion stays pending and the workshop creates a revised version.",
      placeholder:
        "Example: Make this use Gmail labels instead of unread search, and add a safer dry-run step.",
      preparing: "Waiting for chat admission",
      notAdmitted:
        "Revision request was not admitted. Your instructions are still available; review the error and retry. {error}",
      send: "Send revision",
    },
    queue: {
      resize: "Resize list",
      searchSuggestions: "Search suggestions\u2026",
      searchHistory: "Search records\u2026",
      suggestionsLabel: "Search suggestions",
      historyLabel: "Search records",
      loadError: "Could not load this list.",
      loading: "Loading\u2026",
      noMatch: "Nothing matches that search.",
      noSuggestions: "No suggestions waiting.",
      noRecords: "No records yet.",
      noRecordsStatus: "No {status} records.",
    },
    detail: {
      edited: "Edited {time}",
      created: "Created {time}",
      supportFiles: "{count} support files",
      noSupportFiles: "0 support files",
      loading: "Loading\u2026",
      draftMissing:
        "This suggestion's draft is missing. Reject it and ask your agent to create a new suggestion.",
      supportFilesTitle: "Support files",
      clickToPreview: "\u00b7 click to preview",
    },
    evaluation: {
      title: "Evaluation",
      version: "Suggestion {version}",
      completedAt: "Completed {time}",
      status: {
        completed: "Completed",
        skipped: "Skipped",
        error: "Error",
      },
      decision: {
        pass: "Pass",
        revise: "Revise",
        block: "Block",
      },
      severity: {
        info: "Info",
        warn: "Warning",
        critical: "Critical",
      },
      evaluatorVersion: "Evaluator {version}",
      mode: "Mode {mode}",
      findings: "Findings",
      metrics: "Metrics",
      fileLine: "{file}:{line}",
      errors: {
        revisionHashUnavailable: "The current suggestion revision could not be identified.",
        revisionChanged: "The suggestion revision changed during evaluation.",
      },
    },
    empty: {
      searchTitle: "Nothing matches that search",
      searchBody: "Clear the search or try another word.",
      pendingTitle: "No suggestions waiting",
      pendingBody: "New suggestions appear here when they need review.",
      defaultAgent: "Your agent",
      noProposalsAria: "No Skill Workshop suggestions",
      noProposalsTitle: "No suggestions yet",
      noProposalsBody: "{agent} hasn\u2019t suggested any skills.",
      noProposalsFooter: "New suggestions appear here for review.",
    },
    selfLearning: {
      pitchTitle: "Turn on self-learning",
      pitchBody:
        "OpenClaw learns from completed work and improves reusable skills in the background. Reviews use your configured model.",
      enable: "Enable self-learning",
      enabling: "Enabling\u2026",
      updateError: "Could not update the self-learning setting.",
    },
    learning: {
      start: "Learn from past conversations",
      starting: "Opening learning session\u2026",
      title: "Learn from past conversations",
      description:
        "Open a session to find useful lessons and improve skills using your current learning mode.",
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
