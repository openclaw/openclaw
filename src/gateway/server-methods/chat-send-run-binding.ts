import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import type { ReplySessionBinding } from "../../auto-reply/reply/get-reply.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
} from "../../infra/agent-run-registry.js";
import {
  isChatAbortControllerEntryAbortable,
  type ChatAbortControllerEntry,
  type registerChatAbortController,
} from "../chat-abort.js";

/** Transfer the prepared session and admitted root to the original Gateway registration. */
export function createChatSendRunBinding(params: {
  activeRunAbort: Extract<ReturnType<typeof registerChatAbortController>, { registered: true }>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  clientRunId: string;
  sessionKey: string;
  lifecycleGeneration: string;
  isAdmissionActive: () => boolean;
  loadCurrentSessionEntry: () => SessionEntry | undefined;
}) {
  const { activeRunAbort, clientRunId, sessionKey, lifecycleGeneration } = params;
  const entry = activeRunAbort.entry;
  const assertAdmissionCurrent = () => {
    // These predicates can reenter; reread the registration after invoking them.
    const active = isChatAbortControllerEntryAbortable(entry) && params.isAdmissionActive();
    if (
      !active ||
      entry.controller.signal.aborted ||
      params.chatAbortControllers.get(clientRunId) !== entry ||
      lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      entry.registrationCleanupRequested ||
      entry.projectSessionActive === false ||
      entry.projectSessionTerminalPending ||
      entry.projectSessionTerminalPersisted
    ) {
      throw createAbortError("chat session preparation no longer owns its admission");
    }
  };
  entry.isAdmissionCurrent = () =>
    params.isAdmissionActive() && lifecycleGeneration === getAgentEventLifecycleGeneration();
  return {
    sessionBinding: entry,
    onSessionPrepared: (binding: ReplySessionBinding) => {
      if (binding.sessionKey !== sessionKey) {
        return;
      }
      assertAdmissionCurrent();
      entry.sessionId = binding.sessionId;
      if (
        entry.preparedSession?.sessionId !== binding.sessionId ||
        entry.preparedSession.lifecycleRevision !== (binding.lifecycleRevision ?? null)
      ) {
        entry.preparedSession = Object.freeze({
          sessionId: binding.sessionId,
          lifecycleRevision: binding.lifecycleRevision ?? null,
        });
      }
    },
    onAdmittedRunContext: (admitted: AdmittedRunContext): undefined => {
      const prepared = entry.preparedSession;
      const root = getAdmittedRunDelegatedAuthority(admitted);
      const session = params.loadCurrentSessionEntry();
      assertAdmissionCurrent();
      const owner = getAgentRunContext(admitted.operationalRunInstance.runId);
      if (
        !root ||
        root.operationalRunInstance !== admitted.operationalRunInstance ||
        root.lifecycleGeneration !== lifecycleGeneration ||
        owner?.delegatedAuthority !== root ||
        getAgentRunContextOwnerStatus(
          root.operationalRunInstance.runId,
          root.claimId,
          lifecycleGeneration,
        ) !== "active" ||
        !prepared ||
        entry.preparedSession !== prepared ||
        owner.sessionId !== prepared.sessionId ||
        owner.sessionKey !== sessionKey ||
        entry.sessionId !== prepared.sessionId ||
        session?.sessionId !== prepared.sessionId ||
        (session.lifecycleRevision ?? null) !== prepared.lifecycleRevision ||
        (entry.agentRunDelegatedAuthority !== undefined &&
          entry.agentRunDelegatedAuthority !== root) ||
        (entry.operationalRunInstance !== undefined &&
          entry.operationalRunInstance !== admitted.operationalRunInstance)
      ) {
        throw createAbortError("chat run no longer owns its prepared session");
      }
      entry.operationalRunInstance = admitted.operationalRunInstance;
      activeRunAbort.bindAgentRunDelegatedAuthority(root);
      entry.liveActivityRun = Object.freeze({
        publicRunId: clientRunId,
        internalRunId: root.operationalRunInstance.runId,
      });
    },
  };
}
