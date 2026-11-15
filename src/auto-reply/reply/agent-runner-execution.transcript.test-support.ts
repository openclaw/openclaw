import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";

export function createTestUserTurnRecorder(message: PersistedUserTurnMessage) {
  return createUserTurnTranscriptRecorder({
    message,
    target: createTestUserTurnTranscriptTarget(),
    updateMode: "none",
  });
}
