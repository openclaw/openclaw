import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import {
  lifecycleAdmissionByOperation,
  type ReplyOperationAdmission,
} from "../../sessions/session-controller.state.js";

/** Bind the original database borrow to the operation and join lifecycle handoffs on release. */
export function bindReplyOperationDatabaseAdmission(
  readerOperation: ReplyOperation,
  params: { sessionKey: string; workSignal?: AbortSignal },
  lease: SessionEffectRef | undefined,
  databaseClaim: SessionAdmissionDatabaseClaim | undefined,
) {
  let handoff: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let sessionActor: Promise<SessionActor | undefined> | undefined;
  const assertReaderOperation = () => {
    readerOperation.abortSignal.throwIfAborted();
    // Terminal settlement can freeze reply abort while restart still retires its work owner.
    if (releasing) {
      params.workSignal?.throwIfAborted();
    }
    if (releasing || readerOperation.key !== params.sessionKey) {
      throw new SessionWorkStartChangedError("Session reader operation is no longer current");
    }
  };
  const assertTransitionActive = () => {
    assertReaderOperation();
    if (readerOperation.result) {
      throw new SessionWorkStartChangedError("Reply transition is no longer active");
    }
  };
  const releaseSessionActor = async () => {
    const pending = sessionActor;
    const installed = operationAdmission.sessionActor;
    sessionActor = undefined;
    operationAdmission.sessionActor = undefined;
    if (installed) {
      await installed.release();
      return;
    }
    // Acquisition failures already belong to their caller; release only accepted custody.
    const actor = await pending?.catch(() => undefined);
    await actor?.release();
  };
  const operationAdmission: ReplyOperationAdmission = {
    lease,
    databaseIdentity: databaseClaim?.identity,
    databaseClaim,
    reader: databaseClaim && "kind" in databaseClaim ? databaseClaim.reader : undefined,
    sessionTarget: databaseClaim && "kind" in databaseClaim ? databaseClaim.target : undefined,
    resolveReader() {
      operationAdmission.reader?.assertCurrent();
      return operationAdmission.reader;
    },
    resolveSessionTarget() {
      assertReaderOperation();
      operationAdmission.databaseClaim?.assertCurrent();
      return operationAdmission.sessionTarget;
    },
    acquireSessionActor() {
      assertReaderOperation();
      const claim = operationAdmission.databaseClaim;
      if (!claim || !("kind" in claim)) {
        throw new Error("Reply operation has no session actor admission");
      }
      sessionActor ??= claim
        .acquireSessionActor({
          assertCurrent: () => claim.assertCurrent(),
          assertReadable() {
            assertReaderOperation();
            claim.assertCurrent();
          },
        })
        .then((actor) => {
          operationAdmission.sessionActor = actor;
          return actor;
        });
      return sessionActor;
    },
    async afterTransition(transition) {
      assertTransitionActive();
      const current = operationAdmission.databaseClaim;
      const prepare =
        current && "kind" in current ? current.afterTransition?.bind(current) : undefined;
      if (!current || !prepare) {
        return;
      }
      handoff = (async () => {
        const next = await prepare(transition, assertTransitionActive);
        if (releasing) {
          await next.release();
          assertReaderOperation();
        }
        operationAdmission.databaseClaim = next;
        operationAdmission.reader = next.reader;
        operationAdmission.sessionTarget = next.target;
        // Revoke the old view synchronously, then join its accepted work before returning.
        try {
          await releaseSessionActor();
        } finally {
          await current.release();
        }
        assertTransitionActive();
      })();
      try {
        await handoff;
      } finally {
        handoff = undefined;
      }
    },
  };
  lifecycleAdmissionByOperation.set(readerOperation, operationAdmission);
  const releaseWorkerDatabaseClaim =
    databaseClaim && "kind" in databaseClaim
      ? () => {
          if (!releasing) {
            const actorSettlement = sessionActor ? releaseSessionActor() : undefined;
            const settlement = actorSettlement
              ? undefined
              : operationAdmission.databaseClaim?.release();
            releasing = (async () => {
              await Promise.allSettled([handoff, settlement, actorSettlement]);
              if (settlement) {
                await settlement;
              } else {
                try {
                  await actorSettlement;
                } finally {
                  await operationAdmission.databaseClaim?.release();
                }
              }
            })();
          }
          return releasing;
        }
      : undefined;
  return { operationAdmission, releaseWorkerDatabaseClaim };
}
