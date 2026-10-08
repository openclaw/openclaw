// Public transcript watermark contract for context-engine plugins.
// Append, write-lock, catalog, and raw-event helpers stay in the private session-transcript-runtime.

export { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence-error.js";
export {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptMessageEntry,
  type SessionTranscriptVisibleMessageDeltaParams,
  type SessionTranscriptVisibleMessageDeltaResult,
} from "./session-transcript-runtime.js";
