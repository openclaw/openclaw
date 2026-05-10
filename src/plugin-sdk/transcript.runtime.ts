// Public re-exports of session-transcript append helpers used by channel
// plugins that need to record outbound assistant messages directly into a
// session's transcript file (e.g. agent-link, where the sender's outbound
// is initiated from a different session than where the reply will land).

export {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "../config/sessions/transcript.runtime.js";

export type {
  SessionTranscriptAppendResult,
  SessionTranscriptUpdateMode,
  SessionTranscriptAssistantMessage,
} from "../config/sessions/transcript.js";
