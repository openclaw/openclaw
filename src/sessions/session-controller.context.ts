import type {
  ReplyOperation,
  SessionControllerInput,
  SessionControllerMailboxClaim,
} from "./session-controller.contracts.js";
import {
  matchingEntries,
  inputMatchesSessionId,
  selectedClaims,
  selectedEffects,
  selectedOperations,
} from "./session-controller.lifecycle-projections.js";
import { ownerContext } from "./session-controller.owner-context.js";
import { assertSessionControllerOperation } from "./session-controller.state.js";
import { targetFrom, type SessionTarget } from "./session-controller.target.js";

export function withSessionControllerOwner<T>(operation: ReplyOperation, run: () => T): T {
  assertSessionControllerOperation(operation);
  const current = ownerContext.getStore();
  return ownerContext.run(
    {
      sourceInput: current?.sourceInput,
      operation,
      claim: current?.claim,
      effects: current?.effects ?? new Set(),
      mutations: current?.mutations ?? new Set(),
    },
    run,
  );
}
export function getCurrentSessionControllerOwner(): ReplyOperation | undefined {
  return ownerContext.getStore()?.operation;
}

export function getCurrentSessionControllerClaim(): SessionControllerMailboxClaim | undefined {
  return ownerContext.getStore()?.claim;
}
export function withSessionControllerClaim<T>(
  claim: SessionControllerMailboxClaim,
  run: () => T,
): T {
  if (
    claim.released ||
    claim.releaseRequested ||
    claim.mailbox.claim !== claim ||
    claim.mailbox.owner.mailbox !== claim.mailbox
  ) {
    throw new Error("Mailbox claim is no longer current");
  }
  const current = ownerContext.getStore();
  return ownerContext.run(
    {
      sourceInput: current?.sourceInput,
      operation: claim.operation,
      claim,
      effects: current?.effects ?? new Set(),
      mutations: current?.mutations ?? new Set(),
    },
    run,
  );
}
/** True when the input is claimed by the turn executing in this async context. */
export function isCurrentSessionControllerTurnInput(input: SessionControllerInput): boolean {
  const current = ownerContext.getStore();
  if (current?.sourceInput === input) {
    return true;
  }
  const claim = input.claim;
  return Boolean(
    claim &&
    current &&
    (claim === current.claim ||
      (current.operation !== undefined && claim.operation === current.operation)),
  );
}

/** Identify raw cleanup without granting a turn, effect admission, or execution authority. */
export function withSessionControllerSource<T>(input: SessionControllerInput, run: () => T): T {
  const current = ownerContext.getStore();
  return ownerContext.run(
    {
      sourceInput: input,
      operation: current?.operation,
      claim: current?.claim,
      effects: current?.effects ?? new Set(),
      mutations: current?.mutations ?? new Set(),
    },
    run,
  );
}

export function sourceSettlements(
  target: SessionTarget,
  requiredSessionId?: string,
  selection: "all" | "admissions" | "retiring" = "all",
): Promise<void>[] {
  return matchingEntries(target).flatMap(
    (entry) =>
      entry.mailbox?.entries
        .filter(
          (input) =>
            inputMatchesSessionId(input, requiredSessionId) &&
            (selection !== "admissions" || (input.claim !== undefined && !input.claim.operation)) &&
            (selection !== "retiring" || input.retirementRequested) &&
            !isCurrentSessionControllerTurnInput(input),
        )
        .map((input) => input.settlement.promise) ?? [],
  );
}

/** Includes direct producers and accepted unbound sources, not only reply payloads. */
export function hasSessionControllerQueuedWork(
  scope: string,
  identities: Iterable<string | undefined>,
  agentId?: string,
): boolean {
  return matchingEntries(targetFrom({ scope, identities, agentId })).some((entry) => {
    const mailbox = entry.mailbox;
    return Boolean(
      mailbox &&
      (mailbox.droppedCount > 0 ||
        mailbox.entries.some(
          (input) => input.phase !== "consumed" && !isCurrentSessionControllerTurnInput(input),
        )),
    );
  });
}
export function isCompetingSessionControllerWorkActive(
  scope: string,
  identities: Iterable<string | undefined>,
  agentId?: string,
): boolean {
  const target = targetFrom({ scope, identities, agentId });
  const current = ownerContext.getStore();
  return (
    selectedClaims(target).some(
      (claim) =>
        claim !== current?.claim && (!current?.operation || claim.operation !== current.operation),
    ) ||
    [...selectedOperations([target])].some((operation) => operation !== current?.operation) ||
    [...selectedEffects([target])].some(
      (effect) =>
        (effect.phase === "acquired" || effect.phase === "writer") && !current?.effects.has(effect),
    )
  );
}
