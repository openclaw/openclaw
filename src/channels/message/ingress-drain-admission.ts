import { createDeferredCore } from "../../shared/deferred.js";
import type { ChannelIngressAdmissionTurn } from "./ingress-drain-lifecycle.js";
import { holdsAdmissionTurn, type ActiveHandlerState } from "./ingress-drain-state.js";

/**
 * Same-lane downstream admission order. A released deferred lane lets later
 * claims reach channel buffers early (so same-sender bursts still coalesce);
 * their admission turns hold reply admission behind earlier claims that are
 * still buffered or preflighting.
 */
export function createIngressAdmissionTurns<TPayload, TMetadata>(
  activeByClaim: ReadonlyMap<string, ActiveHandlerState<TPayload, TMetadata>>,
) {
  type State = ActiveHandlerState<TPayload, TMetadata>;
  const owners = new WeakMap<ChannelIngressAdmissionTurn, State>();
  const waiters = new Set<{ isReady: () => boolean; resolve: () => void }>();
  let nextSeq = 0;
  let disposed = false;

  // Waiters are few (one per buffered reply turn) and each scan is bounded by
  // the drain's active claims, so re-evaluating on every transition stays cheap.
  const notify = () => {
    for (const waiter of waiters) {
      if (waiter.isReady()) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const wait = async (state: State, batch: readonly ChannelIngressAdmissionTurn[]) => {
    const members = new Set<State>([state]);
    for (const turn of batch) {
      const member = owners.get(turn);
      if (member?.laneKey === state.laneKey) {
        members.add(member);
      }
    }
    const firstSeq = Math.min(...[...members].map((member) => member.dispatchSeq));
    const isReady = () =>
      disposed ||
      state.abortController.signal.aborted ||
      ![...activeByClaim.values()].some(
        (other) =>
          other.laneKey === state.laneKey &&
          other.dispatchSeq < firstSeq &&
          !members.has(other) &&
          holdsAdmissionTurn(other),
      );
    if (isReady()) {
      return;
    }
    const turn = createDeferredCore();
    waiters.add({ isReady, resolve: turn.resolve });
    await turn.promise;
  };

  return {
    /** Registers a newly claimed state; call before dispatch so its turn is ordered. */
    register: (state: State): ChannelIngressAdmissionTurn => {
      state.dispatchSeq = nextSeq++;
      // Abort covers supersede, guillotine, lease loss, and disposal transitions.
      state.abortController.signal.addEventListener("abort", notify, { once: true });
      const turn: ChannelIngressAdmissionTurn = { wait: (batch = []) => wait(state, batch) };
      owners.set(turn, state);
      return turn;
    },
    notify,
    dispose: () => {
      disposed = true;
      notify();
    },
  };
}
