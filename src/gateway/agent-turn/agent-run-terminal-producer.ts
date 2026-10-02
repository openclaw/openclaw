import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";

/** Binds canonical transcript settlement to the exact registered API producer. */
export function bindGatewayAgentTerminalProducer(params: {
  runId: string;
  entry: ChatAbortControllerEntry | undefined;
  controller: AbortController;
  ingressOpts: { abortSignal?: AbortSignal };
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  isOwnerReleased: () => boolean;
}): {
  complete: () => Promise<void>;
  settle: <T>(execution: Promise<T>) => Promise<T>;
} {
  const { entry, controller } = params;
  const registeredRunInstance = entry?.operationalRunInstance;
  const registeredLifecycleGeneration = entry?.lifecycleGeneration;
  const registeredSessionKey = entry?.sessionKey;
  const producerCompletion = createDeferredCore();
  let terminalSettlement: Promise<void> | undefined;
  if (entry && params.ingressOpts.abortSignal === controller.signal) {
    entry.resolveTerminalProducer = () => {
      const { sessionId, sessionKey } = entry;
      const isCurrent = () => {
        const authority = entry.agentRunDelegatedAuthority;
        return (
          !params.isOwnerReleased() &&
          !controller.signal.aborted &&
          params.ingressOpts.abortSignal === controller.signal &&
          params.chatAbortControllers.get(params.runId) === entry &&
          entry.controller === controller &&
          entry.operationalRunInstance === registeredRunInstance &&
          entry.lifecycleGeneration === registeredLifecycleGeneration &&
          entry.sessionId === sessionId &&
          entry.sessionKey === sessionKey &&
          sessionKey === registeredSessionKey &&
          !entry.registrationCleanupRequested &&
          (!registeredLifecycleGeneration ||
            isAgentEventLifecycleGenerationCurrent(registeredLifecycleGeneration)) &&
          (!entry.executionStarted || authority !== undefined) &&
          (!authority ||
            (authority.operationalRunInstance === registeredRunInstance &&
              validateAgentRunDelegatedAuthority(authority)))
        );
      };
      if (!isCurrent()) {
        return undefined;
      }
      return {
        sessionId,
        sessionKey,
        handoff: (settle) => {
          if (!isCurrent()) {
            return false;
          }
          const settlement = settle(producerCompletion.promise);
          terminalSettlement = terminalSettlement
            ? Promise.all([terminalSettlement, settlement]).then(() => undefined)
            : settlement;
          return true;
        },
      };
    };
  }
  const complete = async () => {
    producerCompletion.resolve();
    let joined: Promise<void> | undefined;
    do {
      joined = terminalSettlement;
      await joined;
    } while (joined !== terminalSettlement);
  };
  return {
    complete,
    async settle<T>(execution: Promise<T>): Promise<T> {
      try {
        return await execution;
      } finally {
        await complete();
      }
    },
  };
}
