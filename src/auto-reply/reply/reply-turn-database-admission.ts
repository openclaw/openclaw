import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { replyRunRegistry, type ReplyOperation } from "./reply-run-registry.js";
import {
  lifecycleAdmissionByOperation,
  type ReplyOperationAdmission,
} from "./reply-run-registry.state.js";

/** Bind the original database borrow to the operation and join lifecycle handoffs on release. */
export function bindReplyOperationDatabaseAdmission(
  readerOperation: ReplyOperation,
  params: { sessionKey: string },
  lease: SessionWorkAdmissionLease | undefined,
  databaseClaim: SessionAdmissionDatabaseClaim | undefined,
) {
  let handoff: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let sessionActor: Promise<SessionActor | undefined> | undefined;
  const assertReaderOperation = () => {
    readerOperation.abortSignal.throwIfAborted();
    if (
      releasing ||
      lifecycleAdmissionByOperation.get(readerOperation) !== operationAdmission ||
      replyRunRegistry.get(readerOperation.key) !== readerOperation ||
      readerOperation.key !== params.sessionKey
    ) {
      throw new SessionWorkStartChangedError("Session reader operation is no longer current");
    }
  };
  const bindReader = (borrowedReader: ReplyOperationAdmission["reader"]) =>
    borrowedReader && {
      ...borrowedReader,
      assertCurrent: () => {
        assertReaderOperation();
        borrowedReader.assertCurrent();
      },
      withRead: ((request, assertCallerCurrent, consume) =>
        borrowedReader.withRead(
          request,
          () => {
            assertReaderOperation();
            assertCallerCurrent();
          },
          consume,
        )) satisfies typeof borrowedReader.withRead,
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
    reader: bindReader(databaseClaim && "kind" in databaseClaim ? databaseClaim.reader : undefined),
    sessionTarget: databaseClaim && "kind" in databaseClaim ? databaseClaim.target : undefined,
    resolveReader() {
      assertReaderOperation();
      return operationAdmission.reader;
    },
    resolveSessionTarget() {
      assertReaderOperation();
      operationAdmission.databaseClaim?.assertCurrent();
      return operationAdmission.sessionTarget;
    },
    acquireSessionActor() {
      assertReaderOperation();
      if (handoff) {
        throw new SessionWorkStartChangedError("Session actor admission is changing");
      }
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
        .then(async (actor) => {
          try {
            assertReaderOperation();
            if (claim !== operationAdmission.databaseClaim) {
              throw new SessionWorkStartChangedError("Session actor admission changed");
            }
            operationAdmission.sessionActor = actor;
            return actor;
          } catch (error) {
            await actor?.release();
            throw error;
          }
        });
      return sessionActor;
    },
    async afterTransition(transition) {
      const assertTransitionActive = () => {
        assertReaderOperation();
        if (readerOperation.result !== null) {
          throw new SessionWorkStartChangedError("Reply transition is no longer active");
        }
      };
      assertTransitionActive();
      const current = operationAdmission.databaseClaim;
      const prepare =
        current && "kind" in current ? current.afterTransition?.bind(current) : undefined;
      if (!current || !prepare) {
        return;
      }
      if (handoff) {
        throw new Error("Session transition admission handoff is already pending");
      }
      handoff = (async () => {
        const next = await prepare(transition, assertTransitionActive);
        try {
          assertTransitionActive();
          current.assertCurrent();
          next.assertCurrent();
        } catch (error) {
          await next.release();
          throw error;
        }
        operationAdmission.databaseClaim = next;
        operationAdmission.reader = bindReader(next.reader);
        operationAdmission.sessionTarget = next.target;
        // Revoke the old view synchronously, then join its accepted work before returning.
        try {
          await releaseSessionActor();
        } finally {
          await current.release();
        }
        assertTransitionActive();
        next.assertCurrent();
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
