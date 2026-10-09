import { onTestFinished } from "vitest";
import { onInternalSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { flushClientVoiceSessionWrites } from "../../../talk/client-voice-session.js";
import { voiceTranscriptEventId } from "../../../talk/voice-transcript.js";
import { AGENT_ID, SESSION_ID, requireString } from "./client-native-control.test-support.js";

export async function flushNativeTranscript(
  result: Record<string, unknown>,
  send: () => void,
  expectedWrites = 1,
): Promise<void> {
  const voiceSessionId = requireString(result, "voiceSessionId");
  const prefix = voiceTranscriptEventId(voiceSessionId, "");
  const committed = createDeferredCore();
  const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    if (update.sessionId === SESSION_ID && update.messageId?.startsWith(prefix)) {
      expectedWrites -= 1;
      if (expectedWrites === 0) {
        committed.resolve();
      }
    }
  });
  onTestFinished(unsubscribe);
  try {
    send();
    // Provider admission can yield before entering the lower voice-write queue.
    await committed.promise;
    await flushClientVoiceSessionWrites({ agentId: AGENT_ID, voiceSessionId });
  } finally {
    unsubscribe();
  }
}
