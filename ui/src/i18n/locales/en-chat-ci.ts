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
      automationLabel: "Pull request automations",
      automationAutoFix: "Auto-fix CI & address comments",
      automationAutoMerge: "Auto-merge when ready",
      automationAutoArchive: "Auto-archive on merge or close",
      automationAutoArchiveSession: "Auto-archive session",
      automationAutoFixDescription: "Fix failures and respond to review comments",
      automationAutoMergeDescription: "Once repository requirements are satisfied",
      automationAutoArchiveDescription: "After merge or close, with no work pending",
      automationSchedulerDisabled: "The scheduler is disabled. Enabled automations won’t run.",
      automationSessionRequired:
        "Automations need a verified session identity. Reopen this session and try again.",
      automationReadRequired: "You need read access to view automations.",
      automationAdminRequired: "You need admin access to change automations.",
      automationLoadFailed: "Couldn’t load automations. Try again.",
      automationSaveFailed:
        "Couldn’t confirm the change. Refresh to check the current state before trying again.",
      automationScheduleDisabled:
        "Turned off after {count} scheduling errors. Correct the schedule, then turn this automation back on.",
      automationFailureDisabled:
        "Turned off after {count} failed runs in a row. Fix the cause, then turn this automation back on.",
      automationSourceUnavailable:
        "Turned off because the conversation or owner it runs as is no longer available. Restore it, then turn this automation back on.",
      automationLastError: "Couldn’t complete this automation: {error}",
      automationRetry: "Try again",
    },
  },
} satisfies TranslationMap;

export const registerChatCiEnglish = Object.assign(
  () => Object.assign(en.chat.pullRequests, enChatCi.chat.pullRequests),
  { catalog: enChatCi },
);
