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
      automationHelp: "Agent checks every five minutes; existing permissions and approvals apply.",
      automationDetails: "Automation details",
      automationStopHelp:
        "Turning off requests cancellation; effects already accepted are not undone.",
      automationArchiveHelp:
        "Archive waits for unrelated work to finish and may clean the session’s worktree.",
      automationSchedulerDisabled: "The scheduler is disabled. Enabled jobs will not run.",
      automationSessionRequired:
        "Automations need a verified session identity. Reopen this session and try again.",
      automationReadRequired: "Connect with read access to view automations.",
      automationAdminRequired: "Administrator access is required to change automations.",
      automationRefreshRequired: "Refresh automations before changing them.",
      automationLoadFailed: "Couldn’t load automations. Try again.",
      automationSaveFailed:
        "Couldn’t confirm the change. Refresh to check the current state before trying again.",
      automationRunning: "Running",
      automationStopping: "Stopping",
      automationEnabled: "Enabled",
      automationOff: "Off",
      automationNextCheck: "Next check: {time}",
      automationScheduleDisabled: "Automatically disabled after {count} scheduling errors.",
      automationFailureDisabled: "Automatically disabled after {count} failed runs.",
      automationLastError: "Last error: {error}",
      automationOpenJob: "Open automation",
      automationNoChecks: "No CI checks reported.",
      automationLoading: "Loading automations…",
      automationSaving: "Saving automations…",
      automationUnavailable: "Automations are currently unavailable.",
      automationRetry: "Try again",
    },
  },
} satisfies TranslationMap;

export const registerChatCiEnglish = Object.assign(
  () => Object.assign(en.chat.pullRequests, enChatCi.chat.pullRequests),
  { catalog: enChatCi },
);
