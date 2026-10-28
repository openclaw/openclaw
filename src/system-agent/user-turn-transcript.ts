import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";

/** System-agent runtimes persist caller-owned transcripts without a durable target. */
export function createSystemAgentUserTurnRecorder(prompt: string) {
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: prompt },
    target: () => undefined,
  });
  // These operations rewrite a durable admission. Detached helper turns have no
  // such owner; the runtime projects their model prompt in its in-memory view.
  delete recorder.captureModelPromptProjection;
  delete recorder.prepareModelPromptProjection;
  return recorder;
}
