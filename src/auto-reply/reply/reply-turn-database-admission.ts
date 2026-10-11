import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import type { SessionAdmissionDatabaseClaim } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { ReplyOperation } from "./reply-run-registry.js";
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
  const assertTransitionActive = () => {
    readerOperation.abortSignal.throwIfAborted();
    if (releasing || readerOperation.key !== params.sessionKey) {
      throw new SessionWorkStartChangedError("Session reader operation is no longer current");
    }
    if (readerOperation.result) {
      throw new SessionWorkStartChangedError("Reply transition is no longer active");
    }
  };
  const operationAdmission: ReplyOperationAdmission = {
    lease,
    databaseIdentity: databaseClaim?.identity,
    databaseClaim,
    reader: databaseClaim && "kind" in databaseClaim ? databaseClaim.reader : undefined,
    resolveReader() {
      operationAdmission.reader?.assertCurrent();
      return operationAdmission.reader;
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
          throw new SessionWorkStartChangedError("Session reader operation is no longer current");
        }
        operationAdmission.databaseClaim = next;
        operationAdmission.reader = next.reader;
        await current.release();
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
            const settlement = operationAdmission.databaseClaim?.release();
            releasing = (async () => {
              await Promise.allSettled([handoff, settlement]);
              await settlement;
            })();
          }
          return releasing;
        }
      : undefined;
  return { operationAdmission, releaseWorkerDatabaseClaim };
}
