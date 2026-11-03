import type { SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryTarget } from "../../config/sessions/session-accessor.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { bindUserTurnInputActor } from "../../config/sessions/session-input-actor.js";
import { buildSessionTranscriptTurnExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import { resolveSessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import {
  bindSessionControllerSourceTurnId,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.state.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { readReplyAdmissionSession } from "./reply-input-placement.js";

export type PendingReplyDelivery = {
  context?: DeliveryContext;
  deliveries: NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"];
  intentId: string;
  text: string;
};

/** Transfers ordinary accepted input into its admitted session, without restart checkpoints. */
export function createReplyInputAdmission(params: {
  followupRun: RunReplyAgentParams["followupRun"];
  replyOperation: ReplyOperation;
  sessionKey?: string;
  storePath?: string;
  sourceTurnId?: string;
  setEntry(entry: SessionEntry): void;
}) {
  const { replyOperation, followupRun, sessionKey, storePath } = params;
  let target: SessionEntryTargetPatchScope | undefined;
  const assertCurrent = () => {
    replyOperation.abortSignal.throwIfAborted();
    if (replyOperation.lifecycleGeneration) {
      assertAgentRunLifecycleGenerationCurrent(replyOperation.lifecycleGeneration);
    }
    followupRun.operatorAuthority?.assertCurrent();
  };
  const bindSource = () => {
    assertCurrent();
    if (params.sourceTurnId) {
      bindSessionControllerSourceTurnId(replyOperation, params.sourceTurnId);
    }
  };
  const acquire = async () => {
    const actor = await acquireReplyOperationSessionActor(replyOperation);
    assertCurrent();
    const currentTarget = getReplyOperationSessionTarget(replyOperation);
    if (actor && currentTarget) {
      target = currentTarget;
      return { actor, target: currentTarget };
    }
    return undefined;
  };
  const read = async () => {
    if (!sessionKey) {
      throw new Error("Reply input has no session target");
    }
    const acquired = await acquire();
    if (acquired) {
      const authority = { assertCurrent, authorize: assertCurrent };
      return (acquired.actor.snapshot(authority) ?? (await acquired.actor.read(authority))).entry;
    }
    return readSessionEntryInWorker(
      { agentId: followupRun.run.agentId, sessionKey, storePath },
      assertCurrent,
      undefined,
      (selected) => {
        target = selected;
      },
    );
  };
  return {
    async admitUserTurn(this: void, recorder?: UserTurnTranscriptRecorder): Promise<void> {
      assertCurrent();
      if (!recorder || recorder.hasPersisted()) {
        bindSource();
        return;
      }
      if (!sessionKey || !storePath) {
        await recorder.persistApproved();
        bindSource();
        return;
      }
      const { entry, stagedWorkerInput } = await readReplyAdmissionSession({
        sessionId: replyOperation.sessionId,
        placementContext: recorder?.getPendingInputMessage?.()
          ? resolveSessionWorkerPlacementContext()
          : undefined,
        readEntry: read,
        assertCurrent,
      });
      // Remote placement and staged system events are consumed by the runtime writer.
      if (
        !stagedWorkerInput &&
        recorder &&
        !recorder.hasPersisted() &&
        !(
          followupRun.run.inputProvenance?.kind === "internal_system" &&
          recorder.getPendingInputMessage?.()
        )
      ) {
        bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire });
        const persisted = await recorder.persistApproved({
          target: {
            agentId: followupRun.run.agentId,
            sessionId: entry.sessionId,
            sessionKey,
            sessionEntry: entry,
            storePath: target?.readSource?.path ?? target?.storePath ?? storePath,
            cwd: followupRun.run.workspaceDir,
            config: followupRun.run.config,
          },
          expectedSessionId: entry.sessionId,
          expectedSessionState: buildSessionTranscriptTurnExpectedState(entry),
        });
        if (persisted?.sessionEntry) {
          params.setEntry(persisted.sessionEntry);
        }
      }
      bindSource();
    },
    async recordPendingDelivery(this: void, delivery: PendingReplyDelivery): Promise<void> {
      const entry = await read();
      assertCurrent();
      if (!entry || entry.sessionId !== replyOperation.sessionId || !target) {
        throw new Error("Session changed before recording reply delivery");
      }
      const updated = await patchSessionEntryTarget(
        target,
        (current) => {
          assertCurrent();
          if (
            !current ||
            current.sessionId !== entry.sessionId ||
            current.lifecycleRevision !== entry.lifecycleRevision
          ) {
            throw new Error("Session changed before recording reply delivery");
          }
          return {
            pendingFinalDelivery: {
              ...(delivery.text
                ? { kind: "replayable" as const, text: delivery.text }
                : { kind: "transport-only" as const }),
              createdAt: Date.now(),
              intentId: delivery.intentId,
              deliveries: delivery.deliveries,
              ...(delivery.context ? { context: delivery.context } : {}),
            },
          };
        },
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
          preserveActivity: true,
          workerGuard: { assertCurrent },
        },
      );
      if (updated) {
        params.setEntry(updated);
      }
    },
  };
}
