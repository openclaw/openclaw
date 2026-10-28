import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import { inspectMainSessionRecoveryLifecycleEvent } from "../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { getRuntimeConfig } from "../config/io.js";
import { captureMemoryExactSessionReader } from "../config/sessions/session-accessor.memory-exact-read.js";
import {
  getAgentEventLifecycleGeneration,
  type AgentEventPayload,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import type { ChatRunEntry } from "./server-chat-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

/** Select progress for an already-authorized hidden session subscription. */
export function shouldMirrorAgentEventToHiddenSessionMessages(
  { stream, data }: Pick<AgentEventPayload, "stream" | "data">,
  isAborted: boolean,
): boolean {
  return (
    stream === "item" ||
    stream === "thinking" ||
    stream === "approval" ||
    stream === "lifecycle" ||
    (stream === "compaction" && (data.phase === "start" || data.phase === "end")) ||
    (!isAborted &&
      stream === "assistant" &&
      ((typeof data.text === "string" && data.text.length > 0) ||
        (typeof data.delta === "string" && data.delta.length > 0)) &&
      resolveAssistantEventPhase(data) === "commentary")
  );
}

/** Orders a handler's accepted events around fresh recovery reads, independently of display enrichment. */
export function createAgentEventAdmission({
  handleEvent,
  resolveEventSession,
  isCurrent,
  dispose,
}: {
  handleEvent: (event: AgentEventPayload, recovery?: { suppress: boolean }) => void;
  resolveEventSession: (event: AgentEventRuntimePayload) => {
    chatLink?: ChatRunEntry;
    sessionAgentId?: string;
    eventSessionKey?: string;
    sessionKey?: string;
  };
  isCurrent: (event: AgentEventRuntimePayload) => boolean;
  dispose: () => void;
}) {
  const resolveRestartRecoveryLifecycleState = async (
    sessionKey: string,
    agentId: string | undefined,
    event: AgentEventPayload,
    previous?: Promise<void>,
  ): Promise<{ suppress: boolean; assertCurrent?: () => void }> => {
    const memory = captureMemoryExactSessionReader({ sessionKey, agentId });
    if (memory) {
      // Incognito state cannot survive a restart; only its live memory owner applies.
      return { suppress: false, assertCurrent: () => memory.assertCurrent() };
    }
    if (previous) {
      await previous.catch(() => undefined);
    }
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      ...(agentId ? { agentId } : {}),
    }).catch(() => undefined);
    return {
      suppress: inspectMainSessionRecoveryLifecycleEvent({
        currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
        entry: loaded?.entry,
        event,
      }).suppress,
    };
  };

  const pendingEvents = new Map<string, Promise<void>>();
  let closed = false;
  const acceptEvent = (evt: AgentEventRuntimePayload): void | Promise<void> => {
    if (closed) {
      return;
    }
    if (!isCurrent(evt)) {
      return;
    }
    const phase = evt.stream === "lifecycle" ? evt.data.phase : undefined;
    const terminal =
      phase === "end" || phase === "error"
        ? buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: evt.data })
        : undefined;
    const needsRecoveryRead =
      Boolean(evt.runId.trim() && evt.lifecycleGeneration?.trim()) &&
      (phase === "start" ||
        (terminal?.reason === "cancelled" && terminal.stopReason === "restart"));
    const previous = pendingEvents.get(evt.runId);
    // Only an async boundary needs a routing snapshot; the synchronous handler resolves it once.
    if (!needsRecoveryRead && !previous) {
      return handleEvent(evt);
    }
    const source = resolveEventSession(evt);
    const sessionKey = source.eventSessionKey ?? source.sessionKey;
    const agentId = evt.agentId ?? source.sessionAgentId;
    // Capture live memory ownership now; durable recovery reads wait for earlier
    // events and then read once. Display enrichment stays separate.
    const prepared =
      needsRecoveryRead && sessionKey
        ? resolveRestartRecoveryLifecycleState(sessionKey, agentId, evt, previous)
        : undefined;
    if (!prepared && !previous) {
      return handleEvent(evt);
    }
    const consume = async () => {
      const recovery = await prepared;
      const current = resolveEventSession(evt);
      if (
        current.chatLink !== source.chatLink ||
        (current.eventSessionKey ?? current.sessionKey) !== sessionKey ||
        (evt.agentId ?? current.sessionAgentId) !== agentId
      ) {
        return;
      }
      recovery?.assertCurrent?.();
      handleEvent(evt, recovery);
    };
    const pending = previous ? previous.then(consume, consume) : consume();
    pendingEvents.set(evt.runId, pending);
    const release = () => {
      if (pendingEvents.get(evt.runId) === pending) {
        pendingEvents.delete(evt.runId);
      }
    };
    void pending.then(release, release);
    return pending;
  };
  return Object.assign(
    (event: AgentEventPayload) => runOutsideAsyncWorkScope(() => acceptEvent(event)),
    {
      dispose: async () => {
        closed = true;
        dispose();
        await Promise.allSettled(pendingEvents.values());
        dispose();
      },
    },
  );
}
