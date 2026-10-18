import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatProviderReview = {
  chat: {
    providerReview: {
      pausedTitle: "Chat paused as a precaution",
      stoppedTitle: "Chat stopped as a precaution",
      pausedBody:
        "The provider could not confirm the agent was interpreting your instructions correctly. Review its findings before deciding to continue.",
      stoppedBody:
        "The provider stopped this chat without reviewable findings. This conversation remains stopped; no continuation is available.",
      stoppedWithFindingsBody:
        "The provider stopped this conversation. Review its findings before starting further work.",
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
        "Continuation was requested, but its status could not be refreshed. Check again to see whether it was accepted.",
      noContinuation: "Continuation is not available for this conversation. It remains stopped.",
      continuationFailed: "Continuation was not accepted. This conversation remains paused.",
      queueHelp:
        "Queued messages stay held. Review and retry each message separately after continuation is accepted.",
      queueStopped: "Queued messages remain held.",
      queueHoldFailed:
        "Could not save the queued-message review hold. Free browser storage and try again. No continuation was sent.",
      queuedInputHeld:
        "Held when the provider paused this conversation. Review the findings, then retry this message separately if it is still needed.",
    },
  },
} satisfies TranslationMap;

export const registerChatProviderReviewEnglish = Object.assign(
  () => Object.assign(en.chat, enChatProviderReview.chat),
  { catalog: enChatProviderReview },
);
