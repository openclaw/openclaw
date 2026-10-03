import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";

/** System-agent runtimes persist caller-owned transcripts without a durable target. */
export function createSystemAgentUserTurnRecorder(prompt: string) {
  return createUserTurnTranscriptRecorder({
    input: { text: prompt },
    target: () => undefined,
  });
}
