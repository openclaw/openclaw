import { loadSessionEntryForAdmission } from "../../config/sessions/session-accessor.sqlite-entry-admission.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "./reply-run-registry.state.js";
import { bindReplyOperationDatabaseAdmission } from "./reply-turn-database-admission.js";

/** Real physical admission without adding ingress recovery policy to controller tests. */
export function createReplyRecoveryActorFixture(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  getSessionId: () => string;
  operation?: ReplyOperation;
}) {
  let bound: Promise<{ operation: ReplyOperation; release: () => Promise<void> }> | undefined;
  const admission = () =>
    (bound ??= (async () => {
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
        const { releaseWorkerDatabaseClaim } = bindReplyOperationDatabaseAdmission(
          operation,
          params,
          undefined,
          databaseClaim,
        );
        if (!releaseWorkerDatabaseClaim) {
          throw new Error("Recovery fixture requires an actor-capable database claim");
        }
        return { operation, release: releaseWorkerDatabaseClaim };
      } catch (error) {
        try {
          operation?.complete();
        } finally {
          await databaseClaim.release();
        }
        throw error;
      }
    })());
  return {
    async bind() {
      await admission();
    },
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
