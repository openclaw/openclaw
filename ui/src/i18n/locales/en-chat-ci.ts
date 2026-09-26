import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatCi = {
  chat: {
    pullRequests: {
      checksQueued: "Queued",
      checksSkippedCount: "{count} skipped",
      checksLoading: "Loading jobs and steps…",
      checksEmpty: "No check details are available for this commit.",
      checksUnavailable: "Couldn’t load all CI details. Try again or open the checks on GitHub.",
      checksStale:
        "Some CI details are unavailable or out of date. Try again or open the job on GitHub.",
      checksRateLimited: "GitHub’s rate limit was reached. CI details may be out of date.",
      checksRetryAfter: "Try again in {duration}.",
      checksNoSteps: "This check does not provide GitHub Actions steps.",
      checksStepsUnavailable: "Step details are not available yet.",
      openJob: "Open job on GitHub",
      openCheck: "Open check details",
    },
  },
} satisfies TranslationMap;

export const registerChatCiEnglish = Object.assign(
  () => Object.assign(en.chat.pullRequests, enChatCi.chat.pullRequests),
  { catalog: enChatCi },
);
