import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";

/**
 * Gateway-issued fact that one chat turn was typed directly by an authenticated
 * operator, with that operator's owner status at ingress. Only the Gateway's
 * external chat entry issues it; it is an opaque capability, never a wire or
 * transcript field, so copied metadata or another session cannot present one.
 */
export type HumanSenderTurn = Readonly<{
  /** Binds the fact to the first run that executes the turn; later runs read nothing. */
  bind: (context: AdmittedRunContext) => void;
}>;

type HumanSenderTurnFacts = {
  sessionKey: string;
  senderIsOwner: boolean;
  run?: OperationalRunInstanceRef;
};

const issuedTurns = new WeakMap<object, HumanSenderTurnFacts>();

/** Issue only from authenticated external chat ingress, after classifying the turn. */
export function issueHumanSenderTurn(params: {
  sessionKey: string;
  senderIsOwner: boolean;
}): HumanSenderTurn {
  const facts: HumanSenderTurnFacts = {
    sessionKey: params.sessionKey,
    senderIsOwner: params.senderIsOwner,
  };
  const turn = Object.freeze({
    bind(context: AdmittedRunContext) {
      facts.run ??= context.operationalRunInstance;
    },
  });
  issuedTurns.set(turn, facts);
  return turn;
}

/**
 * Read the sender of the admitted run executing this exact turn. A copied run
 * (followup, retry, maintenance, collected batch) executes under another
 * admitted run instance and reads nothing.
 */
export function readHumanSenderTurn(
  value: unknown,
  run: { sessionKey: string; operationalRunInstance: OperationalRunInstanceRef | undefined },
): { senderIsOwner: boolean } | undefined {
  const facts = typeof value === "object" && value !== null ? issuedTurns.get(value) : undefined;
  if (
    !facts?.run ||
    !run.operationalRunInstance ||
    facts.run !== run.operationalRunInstance ||
    facts.sessionKey !== run.sessionKey
  ) {
    return undefined;
  }
  return { senderIsOwner: facts.senderIsOwner };
}
