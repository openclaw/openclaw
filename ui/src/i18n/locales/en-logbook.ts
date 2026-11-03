import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLogbook = {
  logbook: {
    nav: {
      previousDay: "Previous day",
      nextDay: "Next day",
      today: "Today",
    },
    status: {
      capturing: "Capturing every {seconds}s",
      paused: "Capture paused",
      disabled: "Capture off",
      nodeHelp: "Device providing screen snapshots.",
      pending: "{count} frames queued",
      pendingHelp: "Snapshots waiting for the next analysis batch.",
      analyzing: "Analyzing…",
      captureError: "Capture error",
      batchError: "Analysis error",
      modelMissing: "No vision model",
      modelMissingHelp:
        "Set plugins.entries.logbook.config.visionModel or configure tools.media models.",
    },
    actions: {
      pause: "Pause",
      resume: "Resume",
      analyzeNow: "Analyze now",
    },
    empty: {
      title: "Nothing on the timeline yet.",
      subtitle:
        "Logbook is collecting snapshots; cards appear after the first analysis batch completes.",
    },
    card: {
      keyframeAlt: "Screen snapshot from this activity",
      distractions: "Distractions",
    },
    stats: {
      title: "Day at a glance",
      focus: "{pct}% focus",
      tracked: "{duration} tracked",
    },
    standup: {
      title: "Daily standup",
      generate: "Generate",
      refresh: "Regenerate",
      empty: "Turn today's timeline into a ready-to-paste standup update.",
    },
    ask: {
      title: "Ask your day",
      placeholder: "When did I review the gateway PR?",
      submit: "Ask",
    },
  },
} satisfies TranslationMap;

export const registerLogbookEnglish = Object.assign(
  () => Object.assign(en.logbook, enLogbook.logbook),
  { catalog: enLogbook },
);
