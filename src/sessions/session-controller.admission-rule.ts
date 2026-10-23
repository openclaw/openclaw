import {
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
  type SessionControllerEntry,
  type SessionControllerTurnKind,
} from "./session-controller.contracts.js";

type TurnAdmissionRefusalReason =
  | "active"
  | "successor-barrier"
  | "followup-barrier"
  | "lifecycle-blocked"
  | "waiting-inputs"
  | "stale-claim"
  | "entry-retired"
  | "mailbox-clearing";

export type TurnAdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: TurnAdmissionRefusalReason };

const waitsForFollowupBarrier = {
  visible: false,
  queued_followup: true,
  direct: false,
} as const satisfies Record<SessionControllerTurnKind, boolean>;

/** Delivery delays follow-ups; execution and source cleanup fence every turn kind. */
export function evaluateTurnAdmission(
  entry: SessionControllerEntry,
  options: {
    kind: SessionControllerTurnKind;
    sessionKey: string;
    registeredEntry: SessionControllerEntry | undefined;
    claim?: SessionControllerMailboxClaim;
    selectedInput?: SessionControllerInput | null;
  },
): TurnAdmissionDecision {
  if (options.registeredEntry !== entry) {
    return { admitted: false, reason: "entry-retired" };
  }
  const mailbox = entry.mailbox;
  if (mailbox?.clearing) {
    return { admitted: false, reason: "mailbox-clearing" };
  }
  // Normal completion retains source cleanup after the operation clears.
  // Only a live, explicitly fenced producer can yield before releasing its claim.
  if (mailbox?.claim?.releaseRequested || mailbox?.claim?.operation?.result) {
    return { admitted: false, reason: "stale-claim" };
  }
  if (options.claim && options.selectedInput !== undefined) {
    return { admitted: false, reason: "stale-claim" };
  }
  if (options.claim) {
    const claim = options.claim;
    if (
      !entry.aliases.has(options.sessionKey) ||
      claim.mailbox.owner !== entry ||
      mailbox !== claim.mailbox ||
      mailbox.claim !== claim ||
      claim.releaseRequested ||
      claim.released ||
      claim.operation ||
      claim.inputs.some(
        (input) =>
          input.mailbox !== mailbox ||
          !mailbox.entries.includes(input) ||
          input.claim !== claim ||
          input.phase !== "claimed",
      )
    ) {
      return { admitted: false, reason: "stale-claim" };
    }
  }
  if (options.selectedInput !== undefined) {
    const input = options.selectedInput;
    const sourceCleanupPending = mailbox?.entries.some(
      (candidate) =>
        candidate.phase === "consumed" ||
        (candidate.retirementRequested && !candidate.claim?.operation?.admissionRetired),
    );
    if (!input && sourceCleanupPending) {
      return { admitted: false, reason: "waiting-inputs" };
    }
    if (input) {
      if (
        !mailbox ||
        input.mailbox !== mailbox ||
        !mailbox.entries.includes(input) ||
        (mailbox.claim && !mailbox.claim.operation?.admissionRetired) ||
        input.claim ||
        input.phase !== "waiting" ||
        input.retirementRequested
      ) {
        return { admitted: false, reason: "stale-claim" };
      }
      if (sourceCleanupPending) {
        return { admitted: false, reason: "waiting-inputs" };
      }
    }
  }
  if (waitsForFollowupBarrier[options.kind] && entry.followupBarrier) {
    return { admitted: false, reason: "followup-barrier" };
  }
  if (entry.active) {
    return { admitted: false, reason: "active" };
  }
  if (entry.successorBarrier) {
    return { admitted: false, reason: "successor-barrier" };
  }
  if (
    entry.lifecycle?.blocksTurnAdmission &&
    !isMutationOwnedTurn(entry, options.selectedInput ?? options.claim?.inputs[0])
  ) {
    return { admitted: false, reason: "lifecycle-blocked" };
  }
  if (
    !options.claim &&
    options.selectedInput === undefined &&
    mailbox?.claim &&
    !mailbox.claim.operation?.admissionRetired
  ) {
    return { admitted: false, reason: "stale-claim" };
  }
  if (
    !options.claim &&
    options.selectedInput === undefined &&
    // Consumed inputs remain here until source cleanup settles. Fenced operations
    // are the only exception: their admission was explicitly retired by the owner.
    mailbox?.entries.some((input) => !input.claim?.operation?.admissionRetired)
  ) {
    return { admitted: false, reason: "waiting-inputs" };
  }
  return { admitted: true };
}

/**
 * A mutation body's own turn request runs under that mutation's fence instead of
 * waiting for it to release. Queued mutations behind it do not block that turn;
 * admission closures and retained foreign operations still do.
 */
export function isMutationOwnedTurn(
  entry: SessionControllerEntry,
  input: SessionControllerInput | null | undefined,
): boolean {
  const lifecycle = entry.lifecycle;
  const mutation = input?.mutation;
  return Boolean(
    lifecycle &&
    mutation?.phase === "active" &&
    lifecycle.mutations[0] === mutation &&
    lifecycle.closures.size === 0 &&
    [...lifecycle.operations].every(
      (operation) => operation === entry.active || operation.admissionRetired,
    ),
  );
}

/** Throws the caller-facing admission error when the turn is refused. */
export function assertTurnAdmission(
  entry: SessionControllerEntry,
  options: Parameters<typeof evaluateTurnAdmission>[1],
): void {
  const admission = evaluateTurnAdmission(entry, options);
  if (admission.admitted) {
    return;
  }
  if (admission.reason === "followup-barrier") {
    throw new ReplyRunFollowupAdmissionBlockedError(options.sessionKey);
  }
  if (admission.reason === "successor-barrier") {
    throw new ReplyRunSuccessorAdmissionBlockedError(options.sessionKey);
  }
  throw new ReplyRunAlreadyActiveError(options.sessionKey);
}
