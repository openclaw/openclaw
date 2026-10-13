import { relaySessions, type RelaySession } from "./state.js";

/** How long a cancelled turn waits for the provider to confirm the cancelled response. */
const TURN_BOUND_CANCELLATION_DRAIN_MS = 1_000;
/** How long a stale generation may keep the output fence before the relay reconnects. */
const STALE_OUTPUT_FENCE_MAX_MS = 30_000;

/**
 * Input can drive providers whose server VAD owns interruption. Resume it after
 * bounded cancellation without releasing the interrupted response's output owner.
 * A stalled provider fails closed; elapsed time never authorizes stale output.
 */
export function scheduleRelayCancellationDeadline(
  session: RelaySession,
  params: { turnId: string; reason: string; terminalEpoch: number },
): void {
  setTimeout(() => {
    if (
      relaySessions.get(session.id) !== session ||
      session.toolResultEpoch !== params.terminalEpoch ||
      session.outputOwnership.phase !== "cancelling"
    ) {
      return;
    }
    const fenceId = session.outputOwnership.completeCancellationLocally();
    if (fenceId === undefined) {
      return;
    }
    session.context.logGateway.warn(
      `talk relay: provider did not confirm output cancellation within ${TURN_BOUND_CANCELLATION_DRAIN_MS}ms; keeping the session open and discarding stale output (reason=${params.reason}, turnId=${params.turnId})`,
    );
    setTimeout(() => {
      if (
        relaySessions.get(session.id) === session &&
        session.outputOwnership.isDiscarding(fenceId)
      ) {
        session.failSession("Realtime provider never ended a cancelled response. Reconnecting.");
      }
    }, STALE_OUTPUT_FENCE_MAX_MS).unref?.();
  }, TURN_BOUND_CANCELLATION_DRAIN_MS).unref?.();
}
