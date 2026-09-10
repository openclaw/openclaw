import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { loadSessionEntry } from "../session-utils.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import type {
  prepareAgentRunDispatch,
  PreparedAgentRunDispatch,
} from "./agent-run-admission-phase.js";
import {
  releasePreparedAgentRunUserTurn,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";

type RootAdmission = Pick<
  Parameters<typeof prepareAgentRunDispatch>[0],
  | "cfg"
  | "activeSessionAgentId"
  | "resolvedSessionKey"
  | "suppressVisibleSessionEffects"
  | "isOneShotModelRun"
  | "isRestartRecoveryResumeRun"
  | "canUseInternalRuntimeHandoff"
  | "sessionEntry"
  | "inputProvenance"
  | "images"
  | "offloadedRefs"
  | "assertAdmissionCurrent"
  | "assertGatewayWorkAdmissionAllowed"
  | "lifecycleGeneration"
  | "getAdmittedSessionId"
  | "runId"
  | "markAgentRunAccepted"
  | "context"
  | "agentDedupeKeys"
  | "io"
>;

/** Transfer actionable root input to durable task custody before ordinary execution. */
export function maybeAdmitSupervisedGatewayRoot(input: {
  admission: RootAdmission;
  userTurn: PreparedAgentRunUserTurn;
  activeModel: { provider: string; model: string };
  activeRunAbort: PreparedAgentRunDispatch["activeRunAbort"];
  onInputAccepted: () => void;
  onAccepted: () => void;
  onRejected: (error: unknown) => void;
}): Promise<boolean> | undefined {
  const { admission: params, userTurn, activeModel, activeRunAbort } = input;
  // Internal completions and supervised attempts never enter task admission.
  if (
    !(
      params.cfg.agents?.entries?.[params.activeSessionAgentId]?.taskSupervision?.enabled &&
      params.resolvedSessionKey &&
      userTurn.senderIsOwner &&
      !userTurn.suppressPromptPersistence &&
      !params.suppressVisibleSessionEffects &&
      !params.isOneShotModelRun &&
      !params.isRestartRecoveryResumeRun &&
      !params.canUseInternalRuntimeHandoff &&
      !params.sessionEntry?.spawnedBy &&
      (!params.inputProvenance || params.inputProvenance.kind === "external_user") &&
      params.images.length === 0 &&
      params.offloadedRefs.length === 0
    )
  ) {
    return undefined;
  }
  // Keep ineligible ingress synchronous. Only eligible roots enter the same
  // asynchronous admission boundary as before this ownership extraction.
  const sessionKey = params.resolvedSessionKey;
  return (async () => {
    try {
      const [{ maybeAdmitSupervisedRootTask }, { bindSupervisedRootSource }] = await Promise.all([
        import("../../tasks/supervised-task.admission.js"),
        import("../../tasks/supervised-task.root-source.js"),
      ]);
      const assertCurrent = () => {
        params.assertAdmissionCurrent?.();
        params.assertGatewayWorkAdmissionAllowed();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
        activeRunAbort.controller.signal.throwIfAborted();
        const current = loadSessionEntry(sessionKey, {
          agentId: params.activeSessionAgentId,
          clone: false,
        });
        if (
          current.entry?.sessionId !== params.getAdmittedSessionId() ||
          current.entry.archivedAt !== undefined
        ) {
          throw new Error("Root task source session changed during admission");
        }
      };
      // Admission may commit durable work. Establish the source transcript first;
      // a missing anchor or failed write must not leave an unacknowledged task.
      assertCurrent();
      const persisted = await userTurn.recorder?.persistApproved({
        expectedSessionId: params.getAdmittedSessionId(),
        retryIfUnpersisted: true,
      });
      assertCurrent();
      if (
        !persisted ||
        persisted.admission.sessionId !== params.getAdmittedSessionId() ||
        persisted.admission.agentId !== params.activeSessionAgentId
      ) {
        throw new Error("Root task input has no exact committed transcript anchor");
      }
      const disposition = await maybeAdmitSupervisedRootTask({
        config: params.cfg,
        source: bindSupervisedRootSource({
          config: params.cfg,
          agentId: params.activeSessionAgentId,
          sessionKey,
          sessionId: params.getAdmittedSessionId(),
          namespace: "gateway",
          inputId: params.runId,
        }),
        message: userTurn.message,
        model: `${activeModel.provider}/${activeModel.model}`,
        ownerAuthorized: true,
        internal: false,
        assertCurrent,
      });
      if (disposition.kind === "ordinary") {
        return false;
      }
      // The durable task retains the input. Consume its pending-input owner without
      // inventing a runtime; lifecycle cleanup remains with prepareAgentRunDispatch.
      const acceptedTask = {
        runId: params.runId,
        sessionKey,
        agentId: params.activeSessionAgentId,
        status: "accepted" as const,
        acceptedAt: Date.now(),
        ...(disposition.flowId
          ? { supervisedTask: { flowId: disposition.flowId, episode: disposition.episode } }
          : {}),
      };
      params.markAgentRunAccepted(true);
      setGatewayDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        entry: { ts: Date.now(), ok: true, payload: acceptedTask },
      });
      input.onInputAccepted();
      params.io.emitAcceptance([true, acceptedTask, undefined], { runId: params.runId });
      params.io.emitFinal(
        [
          true,
          {
            ...acceptedTask,
            status: "ok",
            summary:
              disposition.kind === "handled"
                ? disposition.message
                : "Task accepted for supervised continuation; its goal is not yet complete.",
          },
          undefined,
        ],
        { runId: params.runId },
      );
      input.onAccepted();
      return true;
    } catch (error) {
      releasePreparedAgentRunUserTurn(userTurn);
      input.onRejected(error);
      return true;
    }
  })();
}
