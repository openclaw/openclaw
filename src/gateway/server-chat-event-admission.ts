import { isDeepStrictEqual } from "node:util";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import { inspectMainSessionRecoveryLifecycleEvent } from "../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  getAgentEventLifecycleGeneration,
  type AgentEventPayload,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import type { ChatRunEntry } from "./server-chat-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

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
    const cfg = getRuntimeConfig();
    const read = () =>
      loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: sessionKey,
        ...(agentId ? { agentId } : {}),
      }).catch(() => undefined);
    let loaded = await read();
    const source = loaded?.capturedReadSource;
    const assertCurrent = () => {
      if (source && typeof source.databaseIdentity === "string") {
        assertExistingDatabaseIdentity(
          source.path,
          `file:${source.databaseIdentity}`,
          source.databaseBirthtime,
        );
      }
    };
    if (previous && loaded) {
      await previous.catch(() => undefined);
      assertCurrent();
      const refreshed = await read();
      if (refreshed && !isDeepStrictEqual(refreshed.capturedReadSource, source)) {
        throw new Error("Session recovery source changed while awaiting earlier events");
      }
      loaded = refreshed;
    }
    assertCurrent();
    return {
      suppress: inspectMainSessionRecoveryLifecycleEvent({
        currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
        entry: loaded?.entry,
        event,
      }).suppress,
      assertCurrent,
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
    const source = resolveEventSession(evt);
    const sessionKey = source.eventSessionKey ?? source.sessionKey;
    const agentId = evt.agentId ?? source.sessionAgentId;
    const previous = pendingEvents.get(evt.runId);
    // Capture the physical reader before waiting for earlier events. Only the
    // mandatory recovery read delays this run; display enrichment stays separate.
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
