import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceStartedAt,
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../../shared/deferred.js";

/** Binds canonical transcript settlement to the exact registered API producer. */
export function bindGatewayAgentTerminalProducer(params: {
  runId: string;
  entry: RpcSourceRef | undefined;
  controller: Pick<AbortController, "signal" | "abort">;
  ingressOpts: { abortSignal?: AbortSignal };
  isOwnerReleased: () => boolean;
}): {
  complete: (producerError?: unknown) => Promise<void>;
  settle: <T>(execution: Promise<T>) => Promise<T>;
} {
  const { entry, controller } = params;
  const registeredRunInstance = entry?.adapter.operationalRunInstance;
  const registeredLifecycleGeneration = entry && getRpcSourceLifecycleGeneration(entry);
  const registeredSessionKey = entry && getRpcSourceIdentity(entry).sessionKey;
  const producerCompletion = createDeferredCore<unknown>();
  let terminalSettlement: Promise<void> | undefined;
  if (entry && params.ingressOpts.abortSignal === controller.signal) {
    entry.adapter.resolveTerminalProducer = () => {
      const { sessionId, sessionKey } = getRpcSourceIdentity(entry);
      const isCurrent = () => {
        const authority = entry.adapter.agentRunDelegatedAuthority;
        return (
          !params.isOwnerReleased() &&
          !controller.signal.aborted &&
          params.ingressOpts.abortSignal === controller.signal &&
          isRpcSourceRegistered(entry) &&
          entry.input.abortSignal === controller.signal &&
          entry.adapter.operationalRunInstance === registeredRunInstance &&
          getRpcSourceLifecycleGeneration(entry) === registeredLifecycleGeneration &&
          getRpcSourceIdentity(entry).sessionId === sessionId &&
          getRpcSourceIdentity(entry).sessionKey === sessionKey &&
          sessionKey === registeredSessionKey &&
          !entry.input.retirementRequested &&
          (!registeredLifecycleGeneration ||
            isAgentEventLifecycleGenerationCurrent(registeredLifecycleGeneration)) &&
          (getRpcSourceStartedAt(entry) === undefined || authority !== undefined) &&
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
  const complete = async (producerError?: unknown) => {
    producerCompletion.resolve(producerError);
    let joined: Promise<void> | undefined;
    do {
      joined = terminalSettlement;
      await joined;
    } while (joined !== terminalSettlement);
  };
  return {
    complete,
    async settle<T>(execution: Promise<T>): Promise<T> {
      let producerError: unknown;
      try {
        return await execution;
      } catch (error) {
        producerError = error;
        throw error;
      } finally {
        await complete(producerError);
      }
    },
  };
}
