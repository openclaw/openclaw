/**
 * Admission-failure close recovery (#204615).
 *
 * A realtime-relay close can lose its settlement admission or source
 * validation. Live teardown must still finish, but the durable voice record
 * must stay closable: the transcript flush is not the durable close, the
 * session stays in the draining set until the durable close settles, and
 * later close attempts (disconnect cleanup, the expiry timer) retry the real
 * close through the voice owner.
 */
import { runOutsideClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import { closeRelaySession } from "./operations.js";
import { RELAY_SESSION_TTL_MS, type RelaySession } from "./state.js";

export async function rejectRelaySessionClose(
  session: RelaySession,
  closing: NonNullable<RelaySession["closing"]>,
  error: unknown,
  finish: (closeVoice: () => Promise<void>) => Promise<void>,
): Promise<never> {
  closing.reason = "error";
  closing.runTranscript = () => false;
  session.voiceTranscriptQueue.seal();
  // The flush below is local to this failure branch. Do NOT latch it into
  // `session.voiceSessionClose`: the durable voice-session record is still
  // open here, and a latched bare flush makes every later
  // `closeRelayVoiceSession()` return early without calling
  // `closeRelayVoiceSessionRecord()`, leaving the record open until the
  // six-hour stale reaper while the relay already broadcast "closed"
  // (#204615). Leave the latch unset so a later pass can run the real close
  // once settlement authority is available; reuse a real close that was
  // already latched elsewhere.
  const accepted = session.voiceSessionClose ?? session.voiceTranscriptQueue.flush();
  let cleanupError: unknown;
  try {
    await finish(() => accepted);
  } catch (error) {
    cleanupError = error;
  }
  // The teardown (bridge.close + flush) has settled. Only now may a later
  // close attempt retry the durable close: provider teardown callbacks that
  // re-enter closeRelaySession during bridge.close() must join this close,
  // not consume the recovery attempt while the same refusal still holds
  // (#204615).
  closing.voiceCloseRetryable = true;
  // Re-arm the expiry timer so a retained failure always gets another
  // bounded pass through the same close owner, including when the expiry
  // timer itself initiated this close (#204615). The callback must run
  // outside the released settlement context that scheduled it, or capture
  // would match the inactive owner and reject before fresh admission.
  const cleanupTimer = setTimeout(() => {
    runOutsideClientVoiceSessionSettlement(() => {
      void closeRelaySession(session, "completed");
    });
  }, RELAY_SESSION_TTL_MS);
  cleanupTimer.unref();
  session.cleanupTimer = cleanupTimer;
  if (cleanupError !== undefined) {
    throw new AggregateError([error, cleanupError], "Realtime relay close failed", {
      cause: cleanupError,
    });
  }
  throw error;
}
