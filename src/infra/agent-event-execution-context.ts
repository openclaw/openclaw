import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AgentRunContext } from "./agent-run-registry.types.js";

type Routing = Pick<
  AgentRunContext,
  | "agentId"
  | "sessionKey"
  | "sessionId"
  | "completionSource"
  | "isControlUiVisible"
  | "projectSessionLifecycle"
  | "projectSessionMessages"
  | "mainSessionRestartRecovery"
  | "lifecycleStartedAt"
  | "lifecycleGeneration"
  | "isHeartbeat"
  | "verboseLevel"
  | "registeredAt"
>;

type RoutingRecord = { owner: WeakRef<AgentRunContext>; routing: Routing };
type ExecutionContext = {
  lifecycleGeneration: string;
  onceByRun: Map<string, Promise<unknown>>;
  // v2026.9.4 updaters can retain scopes created before routing was captured.
  routingByRun?: Map<string, RoutingRecord>;
};

export function getAgentEventExecutionContext() {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.agentEvents.executionContext"),
    () => new AsyncLocalStorage<ExecutionContext>(),
  );
}

/** Registration owns routing updates; cancellation may clear live authority before callbacks settle. */
export function recordAgentEventRouting(
  runId: string,
  context: AgentRunContext,
  predecessor?: AgentRunContext,
): void {
  const scope = getAgentEventExecutionContext().getStore();
  if (!scope || scope.lifecycleGeneration !== context.lifecycleGeneration) {
    return;
  }
  const routing = {
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    completionSource: context.completionSource,
    isControlUiVisible: context.isControlUiVisible,
    projectSessionLifecycle: context.projectSessionLifecycle,
    projectSessionMessages: context.projectSessionMessages,
    mainSessionRestartRecovery: context.mainSessionRestartRecovery,
    lifecycleStartedAt: context.lifecycleStartedAt,
    lifecycleGeneration: context.lifecycleGeneration,
    isHeartbeat: context.isHeartbeat,
    verboseLevel: context.verboseLevel,
    registeredAt: context.registeredAt,
  };
  const routingByRun = (scope.routingByRun ??= new Map());
  const record = routingByRun.get(runId);
  const previousOwner = record?.owner.deref();
  if (
    record &&
    (previousOwner === context ||
      (predecessor !== undefined &&
        previousOwner === predecessor &&
        record.routing.lifecycleGeneration !== context.lifecycleGeneration))
  ) {
    // Only an accepted replacement of this exact registration can rebind its outer scope.
    if (previousOwner !== context) {
      record.owner = new WeakRef(context);
    }
    record.routing = routing;
  } else {
    routingByRun.set(runId, { owner: new WeakRef(context), routing });
  }
}
