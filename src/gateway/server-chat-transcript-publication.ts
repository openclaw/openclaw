import { getTranscriptMessageRole } from "../agents/embedded-agent-runner/message-visibility.js";
import { readAgentAssistantSource } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logError } from "../logger.js";
import {
  readSessionTranscriptRunId,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { isChatAbortMarkerCurrent, type ChatRunState } from "./server-chat-state.js";
import { readTranscriptMessageIdempotencyKey } from "./session-transcript-entry-message.js";

type PendingPublication = {
  pending: number;
  isCurrent: () => boolean;
  delta?: () => void;
  terminal?: () => void;
};

/** Retire committed source bytes immediately, then hand their wire display to durable history. */
export function createChatTranscriptPublication(params: {
  chatRunState: ChatRunState;
  agentRunSeq: Map<string, number>;
  flush: (
    sessionKey: string,
    agentId: string | undefined,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    options: { controlUiVisible?: boolean; isHeartbeat?: boolean },
  ) => void;
}) {
  const { chatRunState, agentRunSeq } = params;
  const publications = new Set<Promise<void>>();
  const pendingByRun = new Map<string, PendingPublication>();
  const currentPublication = (runId: string): PendingPublication | undefined => {
    const pending = pendingByRun.get(runId);
    if (pending && !pending.isCurrent()) {
      pendingByRun.delete(runId);
      return undefined;
    }
    return pending;
  };
  return {
    holdDelta: (runId: string, publish: () => void): boolean => {
      const pending = currentPublication(runId);
      if (!pending) {
        return false;
      }
      const run = chatRunState.runs.get(runId);
      pending.delta = () => {
        if (chatRunState.runs.get(runId) === run && run?.bufferIsCurrent?.() !== false) {
          publish();
        }
      };
      return true;
    },
    holdTerminal: (runId: string, publish: () => void): boolean => {
      const pending = currentPublication(runId);
      if (!pending) {
        return false;
      }
      // A terminal retains its complete snapshot past normal run cleanup and
      // supersedes paced text. Each run retains at most these two callbacks.
      pending.terminal = publish;
      return true;
    },
    drain: async () => {
      await Promise.allSettled(publications);
    },
    retireTranscript: (event: InternalSessionTranscriptUpdate, publication?: Promise<void>) => {
      const sourceRunId = readSessionTranscriptRunId(event.message);
      if (!sourceRunId || getTranscriptMessageRole(event.message) !== "assistant") {
        return;
      }
      const link = chatRunState.registry.peek(sourceRunId);
      const clientRunId = link?.clientRunId ?? sourceRunId;
      const context = getAgentRunContext(sourceRunId);
      const sessionKey = link?.sessionKey ?? context?.sessionKey;
      const source = readAgentAssistantSource(event.message);
      const mirrorKey = readTranscriptMessageIdempotencyKey(event.message);
      const itemIds = [...(event.assistantItemIds ?? []), ...(mirrorKey ? [mirrorKey] : [])];
      if (
        (!source && itemIds.length === 0) ||
        !sessionKey ||
        sessionKey !== event.sessionKey ||
        (context?.sessionId && context.sessionId !== event.sessionId)
      ) {
        return;
      }
      if (publication) {
        const pending: PendingPublication = currentPublication(clientRunId) ?? {
          pending: 0,
          isCurrent: () => {
            const currentContext = getAgentRunContext(sourceRunId);
            const currentLink = chatRunState.registry.peek(sourceRunId);
            const queuedSuccessor =
              currentLink !== undefined &&
              currentLink.clientRunId !== clientRunId &&
              currentLink.sessionKey === sessionKey &&
              (currentLink.agentId ?? currentContext?.agentId ?? event.agentId) === event.agentId;
            // Completion removes these owners; replacement must leave the old
            // gate before accepting its callbacks. A queued successor has its
            // own wire run; shifting the head must not release the finishing run.
            return (
              (!currentContext ||
                currentContext === context ||
                (queuedSuccessor &&
                  event.sessionId !== undefined &&
                  currentContext.sessionId === event.sessionId)) &&
              (!currentLink || currentLink === link || queuedSuccessor)
            );
          },
        };
        pending.pending += 1;
        pendingByRun.set(clientRunId, pending);
        const release = () => {
          pending.pending -= 1;
          if (pending.pending > 0 || pendingByRun.get(clientRunId) !== pending) {
            return;
          }
          pendingByRun.delete(clientRunId);
          if (!pending.isCurrent()) {
            return;
          }
          if (pending.terminal) {
            pending.terminal();
          } else {
            pending.delta?.();
          }
        };
        const settled = publication.then(release, release).catch((error: unknown) => {
          logError(`gateway: deferred chat publication failed: ${formatErrorMessage(error)}`);
        });
        publications.add(settled);
        void settled.then(() => publications.delete(settled));
      }
      const run = chatRunState.getOrCreate(clientRunId);
      if (
        run.bufferIsCurrent?.() === false ||
        isChatAbortMarkerCurrent(run.abortMarker, link) ||
        !(source
          ? chatRunState.retireSource(clientRunId, source)
          : chatRunState.retireBuffer(clientRunId, itemIds))
      ) {
        return;
      }
      run.liveTextEpoch = {};
      params.flush(
        sessionKey,
        link?.agentId ?? context?.agentId,
        clientRunId,
        sourceRunId,
        agentRunSeq.get(sourceRunId) ?? 0,
        { controlUiVisible: context?.isControlUiVisible, isHeartbeat: context?.isHeartbeat },
      );
    },
  };
}
