import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import {
  getAgentEventLifecycleGeneration,
  type AgentEventPayload,
  type AgentEventRuntimePayload,
} from "../infra/agent-events.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import type { CapturedAgentRunTerminalWriteContext } from "../infra/agent-run-terminal-writes.js";
import {
  markChatAbortTerminalPersistenceError,
  removeChatAbortControllerEntry,
} from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry, LiveActivitySource } from "./chat-abort.types.js";
import { attachLiveActivitySource, readLiveActivitySource } from "./live-activity-source.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

type LifecyclePersistenceParams = Parameters<typeof persistGatewaySessionLifecycleEvent>[0];
type TerminalPersistenceAuthority = {
  claimId: string;
  lifecycleGeneration: string;
  runId: string;
};
type ObservedTerminalPersistenceParams = Omit<
  LifecyclePersistenceParams,
  "assertCommitAllowed" | "event"
> & {
  authority?: TerminalPersistenceAuthority;
  writeContext?: CapturedAgentRunTerminalWriteContext;
  clientRunId?: string;
  event: AgentEventRuntimePayload;
};
type PreparedPersistence = {
  expired: boolean;
  promise: Promise<void>;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
};

function assertTerminalAuthority(authority: TerminalPersistenceAuthority): void {
  if (
    getAgentRunContextOwnerStatus(
      authority.runId,
      authority.claimId,
      authority.lifecycleGeneration,
    ) !== "active"
  ) {
    throw createAgentRunStaleLifecycleError();
  }
}

function terminalEventAuthority(
  event: LifecyclePersistenceParams["event"],
): TerminalPersistenceAuthority | undefined {
  return event.contextClaimId && event.lifecycleGeneration && event.runId
    ? {
        claimId: event.contextClaimId,
        lifecycleGeneration: event.lifecycleGeneration,
        runId: event.runId,
      }
    : undefined;
}

function terminalEventKey(event: {
  contextClaimId?: string;
  lifecycleGeneration?: string;
  runId?: string;
  seq?: number;
}): string | undefined {
  if (!event.runId || event.seq === undefined) {
    return undefined;
  }
  return `${event.contextClaimId ?? ""}\0${event.lifecycleGeneration ?? ""}\0${event.runId}\0${event.seq}`;
}

/** Owns each definitive lifecycle write before optional chat presentation code runs. */
export function createSessionLifecyclePersistenceOwner(
  options: {
    onCommitted?: LifecyclePersistenceParams["onCommitted"];
    onTerminalTransition?: (source: LiveActivitySource, assertCurrent: () => void) => () => void;
  } = {},
) {
  const prepared = new Map<string, PreparedPersistence>();
  const inFlight = new Set<Promise<void>>();
  let localAbort:
    | {
        event: Omit<AgentEventPayload, "seq" | "ts">;
        source?: LiveActivitySource;
        promise: Promise<void>;
      }
    | undefined;

  const track = (promise: Promise<void>, release?: () => void) => {
    inFlight.add(promise);
    const settled = () => {
      inFlight.delete(promise);
      release?.();
    };
    void promise.then(settled, settled);
    return promise;
  };
  const remember = (key: string | undefined, promise: Promise<void>) => {
    if (!key) {
      return promise;
    }
    // Expiry bounds settled promises only. A queued write stays reachable so
    // delayed handler cleanup cannot revoke its claim before commit.
    const entry: PreparedPersistence = {
      expired: false,
      promise,
      settled: false,
      timer: setTimeout(() => {
        if (prepared.get(key) !== entry) {
          return;
        }
        entry.expired = true;
        if (entry.settled) {
          prepared.delete(key);
        }
      }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS),
    };
    entry.timer.unref?.();
    prepared.set(key, entry);
    const settled = () => {
      entry.settled = true;
      if (entry.expired && prepared.get(key) === entry) {
        prepared.delete(key);
      }
    };
    void promise.then(settled, settled);
    return promise;
  };

  const attachLocalAbortSource = (event: AgentEventRuntimePayload) => {
    if (
      localAbort &&
      !event.contextClaimId &&
      event.runId === localAbort.event.runId &&
      event.sessionId === localAbort.event.sessionId &&
      event.lifecycleGeneration === localAbort.event.lifecycleGeneration &&
      event.stream === "lifecycle" &&
      event.data.phase === "end" &&
      event.data.endedAt === localAbort.event.data.endedAt
    ) {
      // Only the synchronous abort call can alias its public event to the
      // captured write. A later run-id lookup cannot mint cancellation authority.
      if (localAbort.source && !readLiveActivitySource(event)) {
        attachLiveActivitySource(event, localAbort.source);
      }
      return localAbort.promise;
    }
    return undefined;
  };

  const observe = (params: ObservedTerminalPersistenceParams) => {
    const key = terminalEventKey(params.event);
    const existing = key ? prepared.get(key)?.promise : undefined;
    if (existing) {
      return existing;
    }
    const localPersistence = attachLocalAbortSource(params.event);
    if (localPersistence) {
      return remember(key, localPersistence);
    }
    const authority = params.authority;
    const source = readLiveActivitySource(params.event);
    const assertCurrent = () => {
      if (authority) {
        assertTerminalAuthority(authority);
      }
      params.writeContext?.assertCurrent();
    };
    const release = source ? options.onTerminalTransition?.(source, assertCurrent) : undefined;
    const persist = () =>
      persistGatewaySessionLifecycleEvent({
        sessionKey: params.sessionKey,
        ...(source ? { liveActivitySource: source } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
        event: {
          ...params.event,
          ...(params.event.contextClaimId ? { contextClaimId: params.event.contextClaimId } : {}),
          ...(params.event.lifecycleGeneration
            ? { lifecycleGeneration: params.event.lifecycleGeneration }
            : {}),
          ...(params.event.mainSessionRestartRecovery === true
            ? { mainSessionRestartRecovery: true as const }
            : {}),
          ...(params.clientRunId ? { clientRunId: params.clientRunId } : {}),
        },
        ...(authority || params.writeContext
          ? {
              assertCommitAllowed: assertCurrent,
            }
          : {}),
      });
    try {
      const promise = params.writeContext ? params.writeContext.run(persist) : persist();
      return remember(key, track(promise, release));
    } catch (error) {
      release?.();
      return remember(
        key,
        Promise.reject(
          error instanceof Error
            ? error
            : new Error("Session lifecycle persistence failed", { cause: error }),
        ),
      );
    }
  };

  const take = (event: LifecyclePersistenceParams["event"]) => {
    const key = terminalEventKey(event);
    if (!key) {
      return undefined;
    }
    const entry = prepared.get(key);
    if (!entry) {
      return undefined;
    }
    clearTimeout(entry.timer);
    prepared.delete(key);
    return entry.promise;
  };

  return {
    observe,
    attachLocalAbortSource,
    withLocalAbort<T>(
      params: {
        entry: ChatAbortControllerEntry;
        entries: Map<string, ChatAbortControllerEntry>;
        event: Omit<AgentEventPayload, "seq" | "ts">;
      },
      abort: () => T,
    ): T {
      const { entry, entries, event } = params;
      const preparedSession = entry.preparedSession;
      const mapping = entry.liveActivityRun;
      const agentId = entry.agentId;
      const generation = entry.lifecycleGeneration;
      if (
        !preparedSession ||
        !mapping ||
        !agentId ||
        !generation ||
        entry.projectSessionTerminalPersistence
      ) {
        return abort();
      }
      const publicRunId = mapping.publicRunId;
      const internalRunId = mapping.internalRunId;
      const sessionKey = entry.sessionKey;
      const source = entry.liveActivityFact?.source;
      const assertCurrent = () => {
        if (
          entries.get(event.runId) !== entry ||
          entry.preparedSession !== preparedSession ||
          entry.liveActivityRun !== mapping ||
          mapping.publicRunId !== publicRunId ||
          mapping.internalRunId !== internalRunId ||
          publicRunId !== event.runId ||
          entry.agentId !== agentId ||
          entry.sessionKey !== sessionKey ||
          entry.sessionId !== preparedSession.sessionId ||
          entry.lifecycleGeneration !== generation ||
          (source && entry.liveActivityFact?.source !== source) ||
          getAgentEventLifecycleGeneration() !== generation
        ) {
          throw createAgentRunStaleLifecycleError();
        }
      };
      try {
        assertCurrent();
      } catch {
        return abort();
      }
      const release = source ? options.onTerminalTransition?.(source, assertCurrent) : undefined;
      const observedAt = typeof event.data.endedAt === "number" ? event.data.endedAt : Date.now();
      // Cancellation owns this write, not the execution capability it is about
      // to revoke. The session transaction still validates the captured generation.
      const promise = track(
        persistGatewaySessionLifecycleEvent({
          sessionKey,
          agentId,
          expectedSession: preparedSession,
          liveActivitySource: source,
          onCommitted: options.onCommitted,
          assertCommitAllowed: assertCurrent,
          event: {
            ...event,
            runId: internalRunId,
            clientRunId: publicRunId,
            sessionId: preparedSession.sessionId,
            lifecycleGeneration: generation,
            ts: observedAt,
            data: { ...event.data },
          },
        }),
        release,
      );
      entry.projectSessionTerminalPersistence = promise;
      entry.projectSessionTerminalObservedAt = observedAt;
      const settled = (persisted: boolean) => {
        if (entry.projectSessionTerminalPersistence !== promise) {
          return;
        }
        entry.projectSessionTerminalPending = false;
        entry.projectSessionTerminalPersistence = undefined;
        entry.projectSessionTerminalPersisted = persisted;
        if (entry.registrationCleanupRequested) {
          removeChatAbortControllerEntry(entries, event.runId, entry);
        }
      };
      void promise.then(
        () => settled(true),
        (error: unknown) => {
          markChatAbortTerminalPersistenceError(entry, error);
          settled(false);
        },
      );
      const previous = localAbort;
      localAbort = { event, source, promise };
      try {
        return abort();
      } finally {
        localAbort = previous;
      }
    },
    persist: (params: LifecyclePersistenceParams) => {
      const preparedPersistence = take(params.event);
      if (preparedPersistence) {
        return preparedPersistence;
      }
      if (
        isDefinitiveRunLifecycle({ phase: params.event.data?.phase, data: params.event.data }) &&
        terminalEventKey(params.event)
      ) {
        // Every definitive lifecycle is prepared by observe(). A missing promise
        // means its exact owner expired or shutdown retired it.
        return Promise.reject(createAgentRunStaleLifecycleError());
      }
      const authority = terminalEventAuthority(params.event);
      const source = params.liveActivitySource;
      const assertCurrent = () => {
        if (authority) {
          assertTerminalAuthority(authority);
        }
        params.assertCommitAllowed?.();
      };
      const release =
        source && params.event.data?.phase === "error"
          ? options.onTerminalTransition?.(source, assertCurrent)
          : undefined;
      const persistence = persistGatewaySessionLifecycleEvent({
        ...params,
        ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
        ...(authority ? { assertCommitAllowed: assertCurrent } : {}),
      });
      return track(persistence, release);
    },
    async drain(): Promise<void> {
      await Promise.allSettled(inFlight);
      for (const entry of prepared.values()) {
        clearTimeout(entry.timer);
      }
      prepared.clear();
    },
  };
}

export type SessionLifecyclePersistenceOwner = ReturnType<
  typeof createSessionLifecyclePersistenceOwner
>;
