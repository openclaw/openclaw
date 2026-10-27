import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.identity.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
  lifecycleAdmissionByOperation,
} from "../../sessions/session-controller.state.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { bindReplyAdmissionRelease } from "./reply-turn-admission-lifecycle.js";

/** Real physical admission without adding ingress recovery policy to controller tests. */
export function createReplyRecoveryActorFixture(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  getSessionId: () => string;
  operation?: ReplyOperation;
}) {
  let bound: ReturnType<typeof acquire> | undefined;
  const admission = () => (bound ??= acquire());
  async function acquire() {
    const { databaseClaim } = await loadSessionEntryForAdmission({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    let operation = params.operation;
    try {
      operation ??= createReplyOperation({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.getSessionId(),
        resetTriggered: false,
      });
      if (!("kind" in databaseClaim)) {
        throw new Error("Recovery fixture requires an actor-capable database claim");
      }
      bindReplyAdmissionRelease({
        operation,
        sessionKey: params.sessionKey,
        sessionId: operation.sessionId,
        admission: undefined,
        recoveryOwnerLease: undefined,
        databaseClaim,
      });
      const admittedOperation = operation;
      return {
        operation,
        operationAdmission: lifecycleAdmissionByOperation.get(operation),
        release: async () => {
          const target = getSessionControllerEntryForOperation(admittedOperation).target;
          admittedOperation.complete();
          const settlement = await waitForReplyRunSuccessorAdmission(admittedOperation.key, null, {
            target,
          });
          if (!settlement.settled || databaseClaim.isCurrent()) {
            throw new Error("Recovery fixture did not retire its database claim");
          }
        },
      };
    } catch (error) {
      try {
        operation?.complete();
      } finally {
        await databaseClaim.release();
      }
      throw error;
    }
  }
  return {
    bind: admission,
    async acquireSessionActor() {
      const { operation } = await admission();
      const actor = await acquireReplyOperationSessionActor(operation);
      if (!actor) {
        return undefined;
      }
      const target = getReplyOperationSessionTarget(operation);
      if (!target) {
        throw new Error("Recovery fixture lost its admitted target");
      }
      return { actor, target };
    },
    async release() {
      await (await bound)?.release();
    },
    async [Symbol.asyncDispose]() {
      const current = await bound?.catch(() => undefined);
      if (current) {
        try {
          current.operation.complete();
        } finally {
          await current.release();
        }
      }
    },
  };
}
