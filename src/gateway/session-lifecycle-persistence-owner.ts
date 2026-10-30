import { isDefinitiveRunLifecycle } from "../agents/agent-run-terminal-outcome.js";
import { getRuntimeConfig } from "../config/io.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import { getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import type { CapturedAgentRunTerminalWriteContext } from "../infra/agent-run-terminal-writes.js";
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
  event: AgentEventRuntimePayload;
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

/** Owns each definitive lifecycle write before optional chat presentation code runs. */
export function createSessionLifecyclePersistenceOwner() {
  let prepared = new WeakMap<LifecyclePersistenceParams["event"], Promise<void>>();
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
    const existing = prepared.get(params.event);
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
        event: params.event,
        ...(params.clientRunId ? { clientRunId: params.clientRunId } : {}),
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
    prepared.set(params.event, promise);
    return promise;
  };

  return {
    observe,
    persist: (params: LifecyclePersistenceParams) => {
      const preparedPersistence = prepared.get(params.event);
      if (preparedPersistence) {
        return preparedPersistence;
      }
      if (isDefinitiveRunLifecycle({ phase: params.event.data?.phase, data: params.event.data })) {
        // Only the original runtime event may reuse its eager definitive write.
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
      prepared = new WeakMap();
    },
  };
}
