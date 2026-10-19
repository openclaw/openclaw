import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMeetings = {
  meetings: {
    emptyTitle: "Your meeting notes, together",
    docs: "Set up meeting transcripts",
    inProgress: "In progress",
    activeNotes:
      "Summaries are generated about every 5 minutes when new speech is captured. Follow the Transcript tab for speech as it is saved.",
    liveCapture: "Live capture",
    liveHint: "Updates automatically every 3 seconds.",
    liveSummaryHint:
      "Summary so far · Updates about every 5 minutes when there is new speech. Final notes are saved when capture ends.",
    liveRetrying: "Updates are delayed. Retrying automatically.",
    waitingForSpeech: "Waiting for speech…",
    noSpeech: "No speech captured",
    listLabel: "Meetings by day",
    newestFirst: "Newest first · grouped by meeting date",
    loadingMeetings: "Loading meetings…",
    loadingSummary: "Loading summary…",
    loadingTranscript: "Loading transcript…",
    summaryPending: "Summary updates about every 5 minutes as new speech is captured.",
    summaryUnavailable: "No saved summary preview is available.",
    noResults: "No meetings match your search",
  },
} satisfies TranslationMap;

export const registerMeetingsEnglish = Object.assign(
  () => {
    Object.assign(en, enMeetings);
  },
  { catalog: enMeetings },
);
