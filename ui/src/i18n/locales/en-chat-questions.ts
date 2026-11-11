import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatQuestions = {
  chat: {
    questions: {
      showSecret: "Show secret",
      hideSecret: "Hide secret",
      resourcePreview: "Preview resource",
      addResources: "Add resources",
      resourceUploadTooLarge: "Selected resources exceed the upload limits.",
      other: "Type your own answer here",
      multilineHint: "Enter adds a line · {shortcut} to continue",
      answer: "Answer",
      answerPlaceholder: "{label}",
      openLink: "Open link",
      externalStepHint: "Complete the step in the new tab, then return here to submit your answer.",
      submit: "Submit",
      next: "Next",
      back: "Back",
      skip: "Skip",
      skipping: "Skipping…",
      skipped: "Skipped",
      collapse: "Collapse question",
      expand: "Expand question",
      eyebrow: "Waiting for your answer",
      summaryLabel: "Question outcome",
      ownAnswerFor: "Your own answer for {header}",
      storeRequestedBy: "Requested by {agent} · {session}",
      requestedBySession: "Asked by",
      storeEntry: "Stores {name} as {kind}",
      storeReplacement: "Replaces {name} — last updated {updated}",
      storeReplacementBy: "Replaces {name} — last updated {updated} by {updatedBy}",
      submitting: "Submitting…",
      submitFailed: "Couldn’t submit your answer. Try again. {error}",
      answered: "Answered",
      answeredElsewhere: "Answered elsewhere",
      unavailable: "Unavailable",
      expired: "Expired",
      disconnected: "Reconnect to try again.",
      loadFailed: "Couldn’t load this question. Try again.",
    },
  },
} satisfies TranslationMap;

export const registerChatQuestionsEnglish = Object.assign(
  () => {
    Object.assign(en.chat.questions, enChatQuestions.chat.questions);
  },
  { catalog: enChatQuestions },
);
