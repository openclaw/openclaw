import { activeSessions } from "./capture.js";

/** Test lifetimes retire periodic work before discarding capture identities or state. */
export async function clearTranscriptCapturesForTest(): Promise<void> {
  await Promise.all(
    [...activeSessions.values()].flatMap((entry) =>
      entry.summaryUpdates ? [entry.summaryUpdates.stop()] : [],
    ),
  );
  activeSessions.clear();
}
