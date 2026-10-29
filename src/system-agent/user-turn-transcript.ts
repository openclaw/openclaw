import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";

/** System-agent runtimes persist caller-owned transcripts without a durable target. */
export function createSystemAgentUserTurnRecorder(prompt: string) {
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: prompt },
    target: () => undefined,
  });
  delete recorder.captureModelPromptProjection;
  return recorder;
}
