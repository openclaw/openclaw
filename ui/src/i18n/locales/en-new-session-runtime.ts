import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Chat and placement recovery need these statuses without the New Session form catalog.
const enNewSessionRuntime = {
  newSession: {
    requiredWorkerUnavailable:
      "The required device is unavailable. Ask an admin to check the cloud profile, then retry.",
    requiredWorkerChanged:
      "The device requirement changed. Start a new session. Your saved message hasn’t been sent.",
    placementStartFailed: "Couldn’t start this session. Retry setup. {error}",
    placementStillStarting:
      "Device setup is still in progress. Retry to check the existing device. Your message hasn’t been sent.",
    placementCompletionUnconfirmed:
      "Could not confirm whether worker setup finished. Retry to check again; your message has not been sent.",
    placementCancelled:
      "Session setup was interrupted and the temporary session was cleaned up. Your prompt is kept here.",
    cloud: "Cloud",
    runsOn: "Runs on {place}",
    starting: "Starting…",
    followUpCommandsUnavailable: "Commands are available after the session is created.",
    followUpReloadBlocked:
      "Finish starting the session or remove its follow-up messages and draft before reloading.",
    followUpsPaused:
      "The first message was not sent. Review it before retrying these follow-up messages.",
    followUpsAdmissionFailed:
      "Your follow-up messages are held. Retry them after checking browser storage.",
    createFailed: "Couldn't create the session.",
    retrySetup: "Retry setup",
    preferenceSaveUnconfirmed:
      "Saving your new-session choices could not be confirmed. Check them before starting a session.",
    worktreeNameClearUnconfirmed:
      "Session accepted, but clearing the saved worktree name could not be confirmed. Check Name before starting another worktree.",
  },
} satisfies TranslationMap;

export const registerNewSessionRuntimeEnglish = Object.assign(
  () => {
    Object.assign(en.newSession, enNewSessionRuntime.newSession);
  },
  { catalog: enNewSessionRuntime },
);
