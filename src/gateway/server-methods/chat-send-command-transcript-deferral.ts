import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { logVerbose } from "../../globals.js";
import { resolveActiveSessionRunId } from "../../sessions/session-controller.queries.js";
import { waitForSessionRunIdle } from "../../sessions/session-controller.wait.js";

/** Bounds how often a deferred exchange re-waits when follow-up turns keep the session busy. */
const MAX_DEFERRED_COMMAND_TRANSCRIPT_WAITS = 8;

/**
 * A command acknowledgement is normally recorded as soon as it is delivered. While another
 * turn owns the session, that write changes the SQLite transcript underneath the running
 * turn's prepared rewrite and the answer is discarded (#194451). Deferring the exchange
 * until the session settles keeps the answer and still records the exchange in later
 * model context, matching the channel dispatcher's deferral.
 */
export function shouldDeferCommandTranscript(params: {
  runtimeOwnsTranscript: boolean;
  sessionKey: string;
  payloads: readonly ReplyPayload[];
}): boolean {
  if (params.runtimeOwnsTranscript || params.payloads.length === 0) {
    return false;
  }
  if (
    !params.payloads.every((payload) => getReplyPayloadMetadata(payload)?.commandReply === true)
  ) {
    return false;
  }
  // Only a turn whose execution started moves the transcript fence; idle acks stay inline.
  return (
    resolveActiveSessionRunId(params.sessionKey, undefined, { executionStartedOnly: true }) !==
    undefined
  );
}

/** Runs the deferred exchange write once the session's running turn settles. */
export function deferCommandTranscriptWrite(params: {
  sessionKey: string;
  write: () => Promise<void>;
}): void {
  void (async () => {
    for (let attempt = 0; attempt < MAX_DEFERRED_COMMAND_TRANSCRIPT_WAITS; attempt += 1) {
      await waitForSessionRunIdle(params.sessionKey);
      if (
        resolveActiveSessionRunId(params.sessionKey, undefined, { executionStartedOnly: true }) ===
        undefined
      ) {
        await params.write();
        return;
      }
    }
    logVerbose("Gateway command transcript recording skipped: session stayed busy after delivery");
  })().catch(() => {
    logVerbose("Gateway command transcript recording failed after delivery");
  });
}
