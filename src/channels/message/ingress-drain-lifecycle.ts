import type { ChannelIngressQueueRecord } from "./ingress-queue.types.js";

/** Drain-owned position of one claim in its lane's downstream admission order. */
export type ChannelIngressAdmissionTurn = {
  /**
   * Resolves once every same-lane claim dispatched before this turn has been
   * admitted downstream (onDeferred / onAdopted) or settled, or once this claim
   * is aborted. Claims in `batch` are one turn: the wait starts from the
   * earliest of them, so members coalesced across other senders never wait on
   * each other.
   */
  wait: (batch?: readonly ChannelIngressAdmissionTurn[]) => Promise<void>;
};

/** Full pre-adoption -> adoption ownership lifecycle for one claimed event. */
export type ChannelIngressDispatchLifecycle = {
  /** Pre-adoption only. After adopt the drain treats this signal as inert. */
  abortSignal: AbortSignal;
  /**
   * Reply admission order. A drain that releases deferred lanes lets later
   * same-lane claims reach channel buffers early; the channel turn kernel waits
   * on this turn (forwarded as turnAdoptionLifecycle.admissionTurn) so their
   * reply admission stays behind earlier claims still buffered or preflighting.
   */
  admissionTurn?: ChannelIngressAdmissionTurn;
  /**
   * Same-lane rows admitted but not yet handed off, excluding this event.
   * Lets channel buffers that span lane rows wait for input that is already durable.
   */
  readLaneBacklog?: () => Promise<readonly ChannelIngressQueueRecord<unknown>[]>;
  /**
   * Fires when recovery-relevant session/run state is durable.
   * Drain completes (tombstones) the claim here -- never at settle.
   */
  onAdopted: () => void | Promise<void>;
  /**
   * Turn ownership deferred to reply-lane admission (queued followup).
   * Claim remains held until adopted or abandoned. This is downstream
   * admission; buffered work returns a deferred dispatch result instead.
   */
  onDeferred: () => void;
  /** Pre-adoption liveness while waiting for reply-lane admission or preflight compaction. */
  onDeferredHeartbeat?: () => void;
  deferredHeartbeatIntervalMs?: number;
  /**
   * Durable adoption finalization is in progress (e.g. settlement hold while
   * committing dedupe). Clears the pre-adoption stall watchdog so a timeout
   * settlement cannot race and dead-letter an about-to-complete claim.
   * Claim stays held until onAdopted / onAbandoned / fail.
   */
  onAdoptionFinalizing: () => void;
  /** Deferred work terminally failed after dispatch returned. */
  onFailed?: (error: unknown) => void | Promise<void>;
  /** Explicit cancellation before adoption; releases without consuming retry budget. */
  onCancelled?: () => void | Promise<void>;
  /**
   * Deferred turn finished without ever owning the reply lane.
   * Drain releases the claim for retry.
   */
  onAbandoned: () => void | Promise<void>;
};

/** One admission turn for a reply turn that consumes several claims. */
export function combineIngressAdmissionTurns(
  turns: readonly (ChannelIngressAdmissionTurn | undefined)[],
): ChannelIngressAdmissionTurn | undefined {
  const members = turns.filter((turn) => turn !== undefined);
  if (members.length <= 1) {
    return members[0];
  }
  return {
    wait: async (batch = []) => {
      const joined = [...members, ...batch];
      await Promise.all(members.map((turn) => turn.wait(joined)));
    },
  };
}

/** Maps a drain lifecycle onto the reply-lane ownership surface. */
export function bindIngressLifecycleToReplyOptions(lifecycle: ChannelIngressDispatchLifecycle): {
  turnAdoptionLifecycle: Omit<
    ChannelIngressDispatchLifecycle,
    "onAdoptionFinalizing" | "onFailed" | "onCancelled" | "readLaneBacklog"
  > & { admission: "exclusive" };
} {
  return {
    turnAdoptionLifecycle: {
      admission: "exclusive",
      onAdopted: lifecycle.onAdopted,
      onDeferred: lifecycle.onDeferred,
      onDeferredHeartbeat: lifecycle.onDeferredHeartbeat,
      deferredHeartbeatIntervalMs: lifecycle.deferredHeartbeatIntervalMs,
      onAbandoned: lifecycle.onAbandoned,
      abortSignal: lifecycle.abortSignal,
      ...(lifecycle.admissionTurn ? { admissionTurn: lifecycle.admissionTurn } : {}),
    },
  };
}

// onAdoptionFinalizing stays drain-only (not reply-options); channels call it
// via the spooled-replay ALS lifecycle frame during settlement hold.
