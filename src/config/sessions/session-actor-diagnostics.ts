import { channel } from "node:diagnostics_channel";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionActorPhase, SessionActorSettlement } from "./session-actor-contract.js";

type SessionActorObservation = {
  settled(outcome: SessionActorSettlement | "stale-version" | "read" | "rejected"): void;
};

const commands = channel("openclaw.session.actor.command");
const sequence = resolveGlobalSingleton(Symbol.for("openclaw.sessionActorCommandSequence"), () => ({
  value: 0,
}));
const unobserved: SessionActorObservation = { settled() {} };

/** Census only: no session identifiers, payloads, or inferred database/transaction counts. */
export function observeSessionActorCommand(
  phase: SessionActorPhase | "read",
): SessionActorObservation {
  if (!commands.hasSubscribers) {
    return unobserved;
  }
  const id = ++sequence.value;
  commands.publish({ event: "begin", sequence: id, phase });
  let finished = false;
  return {
    settled(outcome) {
      if (finished) {
        return;
      }
      finished = true;
      commands.publish({ event: "settled", sequence: id, phase, outcome });
    },
  };
}
