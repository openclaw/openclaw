/** Pre-execution predecessor ordering for one retained mailbox claim. */
import { createDeferredCore } from "../shared/deferred.js";
import type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
} from "./session-controller.contracts.js";
import { logSessionControllerPhase } from "./session-controller.diagnostics.js";
import { retireSessionControllerInput } from "./session-controller.mailbox-source.js";
import {
  reserveOrJoinSessionControllerSource,
  type reserveSessionControllerSource,
} from "./session-controller.mailbox.js";

function retainsPreExecutionClaimCustody(claim: SessionControllerMailboxClaim): boolean {
  return (
    !claim.released &&
    !claim.releaseRequested &&
    !claim.operation &&
    !claim.abortController.signal.aborted &&
    !claim.custody.adopted &&
    !claim.custody.adopting &&
    !claim.custody.completed &&
    !claim.custody.settling &&
    claim.inputs.every(
      (input) =>
        input.mailbox === claim.mailbox &&
        input.claim === claim &&
        input.phase === "claimed" &&
        claim.mailbox.entries.includes(input) &&
        !input.abortSignal.aborted &&
        !input.retirementRequested &&
        input.injection === undefined &&
        !input.custody.adopted &&
        !input.custody.adopting &&
        !input.custody.completed &&
        !input.custody.settling,
    )
  );
}

function orderSessionControllerClaimPredecessor(
  claim: SessionControllerMailboxClaim,
  predecessor: SessionControllerInput,
): void {
  const mailbox = claim.mailbox;
  const predecessorIndex = mailbox.entries.indexOf(predecessor);
  const claimIndex = Math.min(...claim.inputs.map((input) => mailbox.entries.indexOf(input)));
  const claimSequence = Math.min(...claim.inputs.map((input) => input.sequence));
  mailbox.entries.splice(predecessorIndex, 1);
  mailbox.entries.splice(claimIndex, 0, predecessor);
  for (const input of mailbox.entries) {
    if (input !== predecessor && input.sequence >= claimSequence) {
      input.sequence++;
      mailbox.nextSequence = Math.max(mailbox.nextSequence, input.sequence);
    }
  }
  predecessor.sequence = claimSequence;
  mailbox.claim = undefined;
}

function waitForSessionControllerClaimRestoration(
  claim: SessionControllerMailboxClaim,
  predecessor: SessionControllerInput,
): Promise<boolean> {
  const mailbox = claim.mailbox;
  const restoration = createDeferredCore<boolean>();
  let settled = false;
  const finish = (restored: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    claim.abortController.signal.removeEventListener("abort", onAbort);
    logSessionControllerPhase({
      phase: "recovery-predecessor",
      status: restored ? "restored" : "failed",
      sessionKey: mailbox.key,
      sourceId: predecessor.protocolRunId ?? predecessor.instance.id,
      reason: restored ? "claim-restored" : "claim-revoked",
    });
    restoration.resolve(restored);
  };
  const onAbort = () => finish(false);
  claim.abortController.signal.addEventListener("abort", onAbort, { once: true });
  const restore = () => {
    if (!retainsPreExecutionClaimCustody(claim)) {
      finish(false);
      mailbox.wake();
      return;
    }
    const priority = mailbox.priority;
    if (priority && priority !== predecessor) {
      mailbox.wake();
      void (mailbox.claim?.settlement.promise ?? priority.settlement.promise).then(
        restore,
        restore,
      );
      return;
    }
    const active = mailbox.claim;
    if (active) {
      void active.settlement.promise.then(restore, restore);
      return;
    }
    mailbox.claim = claim;
    finish(true);
    mailbox.wake();
  };
  void predecessor.settlement.promise.then(restore, restore);
  return restoration.promise;
}

/** Orders one new or joined predecessor before a selected source without retiring either claim. */
export function reserveSessionControllerClaimPredecessor(
  claim: SessionControllerMailboxClaim,
  params: Parameters<typeof reserveSessionControllerSource>[1],
): {
  input: SessionControllerInput;
  /** False when another owner reserved this input; only its creator may retire it. */
  created: boolean;
  /** Resolves true only after the retained claim owns the mailbox again. */
  restored: Promise<boolean>;
} {
  const mailbox = claim.mailbox;
  const firstEligible = mailbox.entries.find((input) => input.phase !== "consumed");
  if (
    !retainsPreExecutionClaimCustody(claim) ||
    mailbox.claim !== claim ||
    !firstEligible ||
    !claim.inputs.includes(firstEligible)
  ) {
    throw new Error("Only a current pre-execution claim can hand off to a predecessor");
  }

  const { input: predecessor, created } = reserveOrJoinSessionControllerSource(mailbox.key, params);
  // A joined input may already wait for its own turn admission; it never injects or runs yet.
  if (
    predecessor.mailbox !== mailbox ||
    !mailbox.entries.includes(predecessor) ||
    predecessor.claim ||
    predecessor.injection ||
    (predecessor.phase !== "preparing" && (created || predecessor.phase !== "waiting"))
  ) {
    if (created) {
      retireSessionControllerInput(predecessor);
    }
    throw new Error("Predecessor reservation does not belong to the selected controller claim");
  }

  // Reorder both selector and cancellation sequence before exposing the open slot.
  orderSessionControllerClaimPredecessor(claim, predecessor);
  logSessionControllerPhase({
    phase: "recovery-predecessor",
    status: "reserved",
    ...(created ? {} : { reason: "joined" }),
    sessionKey: mailbox.key,
    sourceId: predecessor.protocolRunId ?? predecessor.instance.id,
  });
  const restored = waitForSessionControllerClaimRestoration(claim, predecessor);
  mailbox.wake();
  return { input: predecessor, created, restored };
}
