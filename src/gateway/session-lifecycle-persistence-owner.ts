import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import { getRuntimeConfig } from "../config/io.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import type { CapturedAgentRunTerminalWriteContext } from "../infra/agent-run-terminal-writes.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import { AsyncWorkScope, runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import {
  prepareGatewaySessionLifecycleEvent,
  type persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

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
  cancelExpiry: () => void;
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
export function createSessionLifecyclePersistenceOwner(scheduler: GatewayScheduler) {
  const prepared = new Map<string, PreparedPersistence>();
  const work = new AsyncWorkScope();
  const pendingBySession = new Map<string, Promise<void>>();
  let closing = false;
  const track = (persist: () => Promise<void>) => {
    if (closing) {
      return Promise.reject(createAgentRunStaleLifecycleError());
    }
    return runWithRetainedGatewayRootWork(() =>
      runOutsideAsyncWorkScope(() => work.track(persist)),
    );
  };
  const enqueue = (params: LifecyclePersistenceParams) => {
    const target = resolveSessionStoreIdentity({
      cfg: getRuntimeConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    const persist = prepareGatewaySessionLifecycleEvent(params);
    const key = JSON.stringify([target.agentId, target.canonicalKey]);
    const previous = pendingBySession.get(key);
    const promise = previous ? previous.then(persist, persist) : persist();
    pendingBySession.set(key, promise);
    const release = () => {
      if (pendingBySession.get(key) === promise) {
        pendingBySession.delete(key);
      }
    };
    void promise.then(release, release);
    return promise;
  };

  const observe = (params: ObservedTerminalPersistenceParams) => {
    const key = terminalEventKey(params.event);
    const existing = key ? prepared.get(key)?.promise : undefined;
    if (existing) {
      return existing;
    }
    if (closing) {
      return Promise.reject(createAgentRunStaleLifecycleError());
    }
    const authority = params.authority;
    const persist = () =>
      enqueue({
        sessionKey: params.sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        event: {
          ...params.event,
          ...(params.event.controlUiVisible !== undefined
            ? { controlUiVisible: params.event.controlUiVisible }
            : {}),
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
              assertCommitAllowed: composeSessionSourceAssertion([
                authority ? () => assertTerminalAuthority(authority) : undefined,
                params.writeContext?.assertCurrent,
              ]),
            }
          : {}),
      });
    const promise = track(() =>
      params.writeContext ? params.writeContext.run(persist) : persist(),
    );
    let entry: PreparedPersistence | undefined;
    const settle = () => {
      if (!entry) {
        return;
      }
      entry.settled = true;
      if (entry.expired && key && prepared.get(key) === entry) {
        prepared.delete(key);
      }
    };
    void promise.then(settle, settle);
    if (key) {
      // Expiry bounds settled promises only. A queued write stays reachable so
      // delayed handler cleanup cannot revoke its claim before commit.
      const preparedEntry: PreparedPersistence = {
        expired: false,
        promise,
        settled: false,
        cancelExpiry: scheduler.schedule({
          id: `session-lifecycle-persistence:${key}`,
          delayMs: AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
          run: () => {
            if (prepared.get(key) !== preparedEntry) {
              return;
            }
            preparedEntry.expired = true;
            if (preparedEntry.settled) {
              prepared.delete(key);
            }
          },
        }).cancel,
      };
      entry = preparedEntry;
      prepared.set(key, preparedEntry);
    }
    return promise;
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
    entry.cancelExpiry();
    prepared.delete(key);
    return entry.promise;
  };

  return {
    observe,
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
      return track(() =>
        enqueue({
          ...params,
          ...(authority
            ? {
                assertCommitAllowed: composeSessionSourceAssertion([
                  () => assertTerminalAuthority(authority),
                  params.assertCommitAllowed,
                ]),
              }
            : {}),
        }),
      );
    },
    async drain(): Promise<void> {
      closing = true;
      // Accepted persistence owns its cancellation scope until its cleanup has joined.
      await AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () => work.drain(),
      );
      for (const entry of prepared.values()) {
        entry.cancelExpiry();
      }
      prepared.clear();
    },
  };
}
