import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatProviderReview = {
  chat: {
    providerReview: {
      pausedTitle: "Session paused as a precaution",
      stoppedTitle: "Session stopped as a precaution",
      pausedBody:
        "The provider couldn’t confirm the agent was interpreting your instructions correctly. Review its findings before deciding to continue.",
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
      refreshFailed:
        "Couldn’t refresh the continuation status. Check again to see whether it was accepted.",
      noContinuation: "This session can’t continue. It remains stopped.",
      continuationFailed: "Couldn’t continue this session. It remains paused. Try again.",
      queueHelp:
        "Queued messages stay held. Review and retry each message separately after continuation is accepted.",
      queueStopped: "Queued messages remain held.",
      queueHoldFailed:
        "Couldn’t save the queued-message review hold. Free browser storage and try again. No continuation was sent.",
      queuedInputHeld:
        "Held when the provider paused this session. Review the findings, then retry this message separately if it’s still needed.",
    },
  },
} satisfies TranslationMap;

export const registerChatProviderReviewEnglish = Object.assign(
  () => Object.assign(en.chat, enChatProviderReview.chat),
  { catalog: enChatProviderReview },
);
