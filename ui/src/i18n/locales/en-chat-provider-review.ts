import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatProviderReview = {
  chat: {
    providerReview: {
      pausedTitle: "Session paused as a precaution",
      stoppedTitle: "Session stopped as a precaution",
      pausedBody:
        "The provider couldn’t confirm the agent understood your instructions. Review its findings before continuing.",
      stoppedBody:
        "The provider stopped this session without reviewable findings. It can’t continue.",
      stoppedWithFindingsBody:
        "The provider stopped this session. Review its findings before starting more work.",
      review: "Review findings",
      findings: "Provider findings",
      continuationTitle: "Continuation message",
      continuationBody: "Acknowledging sends this exact provider-supplied message:",
      acknowledge: "Acknowledge findings and continue",
      continuing: "Requesting continuation…",
      waiting: "Continuation requested. Waiting for the provider to accept it.",
      checkStatus: "Check continuation status",
      checkingStatus: "Checking continuation status…",
      refreshFailed: "Couldn’t check whether continuation was accepted. Check again.",
      noContinuation: "This session can’t continue. It remains stopped.",
      continuationFailed: "Couldn’t continue this session. Try again.",
      queueHelp:
        "Queued messages stay held. Review and retry each message separately after continuation is accepted.",
      queueStopped: "Queued messages remain held.",
      queueHoldFailed:
        "Couldn’t pause queued messages. Free browser storage and retry. No continuation was sent.",
      queuedInputHeld:
        "Held when the provider paused this session. Review the findings before retrying this message.",
    },
  },
} satisfies TranslationMap;

export const registerChatProviderReviewEnglish = Object.assign(
  () => Object.assign(en.chat, enChatProviderReview.chat),
  { catalog: enChatProviderReview },
);
