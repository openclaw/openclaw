import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Chat and placement recovery need these statuses without the New Session form catalog.
const enNewSessionRuntime = {
  newSession: {
    requiredWorkerUnavailable:
      "The required worker is unavailable. Ask an administrator to check the worker profile, then retry.",
    requiredWorkerChanged:
      "The required worker policy changed. Start a new session; this saved message has not been sent.",
    placementStartFailed: "The session was created, but startup needs attention: {error}",
    placementStillStarting:
      "Worker setup is still in progress. Retry to check the existing worker; your message has not been sent.",
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
  },
} satisfies TranslationMap;

export const registerNewSessionRuntimeEnglish = Object.assign(
  () => {
    Object.assign(en.newSession, enNewSessionRuntime.newSession);
  },
  { catalog: enNewSessionRuntime },
);
