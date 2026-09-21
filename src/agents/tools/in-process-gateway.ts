import { AsyncLocalStorage } from "node:async_hooks";
import {
  createCronMutationCompletion,
  type CronMutationCompletion,
} from "../../cron/mutation-completion.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
/** In-process Gateway calls for built-in agent tools. */
import type { CallGatewayOptions } from "../../gateway/call.js";
import { withInProcessAgentRuntimeIdentity } from "../../gateway/in-process-agent-runtime-identity.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "../../gateway/in-process-subagent-resume.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../gateway/method-scopes.js";
import type { TrustedSessionCreation } from "../../gateway/server-methods/session-creation-provenance.js";
import type {
  GatewayAgentRunTaskOwner,
  GatewayContextResolver,
  GatewayRequestContext,
  TrustedAgentToolCaller,
} from "../../gateway/server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  getInProcessGatewayRequestContext,
  runWithOperatorToolGatewayCleanupContext,
} from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { callGatewayTool } from "./gateway.js";

type InProcessGatewayCallOptions = {
  onExecution?: (execution: Promise<void>) => void;
  resolveGatewayContext?: GatewayContextResolver;
  sessionMutationCommitGuard?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number | null;
};

export type InProcessGatewayCaller = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  options?: InProcessGatewayCallOptions,
) => Promise<T>;

type AgentToolGatewayRequest = Pick<
  CallGatewayOptions,
  | "assertDispatchCurrent"
  | "config"
  | "expectFinal"
  | "method"
  | "onAccepted"
  | "onSignalAbort"
  | "params"
  | "signal"
  | "scopes"
  | "timeoutMs"
> & {
  agentRunTracking?: GatewayAgentRunTaskOwner;
  agentToolCaller?: TrustedAgentToolCaller;
};

const agentToolGatewayRuntimeIdentities = new WeakMap<object, AgentRuntimeIdentity>();

/** Carry trusted runtime identity without making it enumerable or transportable. */
export function withAgentToolGatewayRuntimeIdentity<T extends object>(
  request: T,
  identity: AgentRuntimeIdentity | undefined,
): T {
  if (!identity) {
    return request;
  }
  const carried = { ...request };
  agentToolGatewayRuntimeIdentities.set(carried, identity);
  return bindInProcessSubagentResume(carried, readInProcessSubagentResume(request));
}

export type AgentToolGatewayRequestCaller = <T = Record<string, unknown>>(
  request: AgentToolGatewayRequest,
) => Promise<T>;

const DEFAULT_IN_PROCESS_GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

function callerGatewayContextResolver(
  explicit?: GatewayContextResolver,
): GatewayContextResolver | undefined {
  return explicit ?? getGatewayToolCallerIdentity()?.gatewayContextResolver;
}

/** Transfer already-owned cleanup to its Gateway, without retaining the finished turn. */
export function runWithGatewayToolCleanupContext<T>(
  run: () => T,
  explicitResolver?: GatewayContextResolver,
): T {
  const resolveGatewayContext = callerGatewayContextResolver(explicitResolver);
  return withoutGatewayToolCallerIdentity(() =>
    runWithOperatorToolGatewayCleanupContext(() =>
      resolveGatewayContext
        ? withPluginRuntimeGatewayContextResolver(resolveGatewayContext, run)
        : run(),
    ),
  );
}

function bindInProcessGatewayContext(
  method: string,
  resolveGatewayContext: GatewayContextResolver,
): { assertCurrent: () => void; resolve: GatewayContextResolver } {
  const admittedContext = resolveGatewayContext();
  if (!admittedContext) {
    throw new Error(`Gateway instance unavailable for ${method}`);
  }
  const assertCurrent = () => {
    if (resolveGatewayContext() !== admittedContext) {
      throw new Error(`Gateway instance unavailable for ${method}`);
    }
  };
  return {
    assertCurrent,
    resolve: () => {
      assertCurrent();
      return admittedContext;
    },
  };
}

async function runBoundInProcessGatewayCall<T>(
  boundGateway: ReturnType<typeof bindInProcessGatewayContext> | undefined,
  run: (resolveGatewayContext?: GatewayContextResolver) => Promise<T>,
  assertCallerCurrent?: () => void,
  revalidateOnCompletion = true,
  completion?: CronMutationCompletion,
): Promise<T> {
  const assertCurrent = (afterDispatch = false) => {
    boundGateway?.assertCurrent();
    if (!afterDispatch || (completion ? !completion.isCommitted() : revalidateOnCompletion)) {
      assertCallerCurrent?.();
    }
  };
  try {
    assertCurrent();
    const result = completion
      ? await completion.run(() => run(boundGateway?.resolve))
      : await run(boundGateway?.resolve);
    assertCurrent(true);
    return result;
  } catch (error) {
    assertCurrent(true);
    throw error;
  }
}

export function hasInProcessGatewayToolContext(): boolean {
  return Boolean(getInProcessGatewayRequestContext(callerGatewayContextResolver()));
}

/** Whether Gateway routing belongs to this caller or the hosting process. */
export function hasGatewayToolRoutingContext(): boolean {
  const resolver =
    callerGatewayContextResolver() ?? getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const context = getInProcessGatewayRequestContext(resolver);
  // A retired binding still owns routing: dispatch must reject it instead of
  // letting optional Gateway-backed tools switch to standalone host execution.
  return context?.localEmbedded !== true && Boolean(resolver || context);
}

export function getInProcessGatewayToolContext(
  explicitResolver?: GatewayContextResolver,
): GatewayRequestContext | undefined {
  return getInProcessGatewayRequestContext(callerGatewayContextResolver(explicitResolver));
}

/**
 * Dispatches a request-shaped built-in tool call through the local Gateway
 * router without opening a loopback transport. Outside a Gateway process, the
 * same request falls back to the ordinary Gateway client.
 */
async function callAgentToolGatewayRequestBound<T>(
  request: AgentToolGatewayRequest,
  resolveGatewayContext: GatewayContextResolver | undefined,
  runtimeIdentity: AgentRuntimeIdentity | undefined,
  assertCallerCurrent: ReturnType<typeof captureGatewayToolCallerAssertion>,
  forceTransport = false,
  revalidateOnCompletion = true,
): Promise<T> {
  const method = request.method;
  const assertDispatchCurrent = request.assertDispatchCurrent;
  const completion = createCronMutationCompletion(method);
  const assertCurrent =
    assertCallerCurrent ||
    assertDispatchCurrent ||
    ((!revalidateOnCompletion || completion) && request.signal)
      ? () => {
          assertCallerCurrent?.(method);
          assertDispatchCurrent?.();
          if (!revalidateOnCompletion || completion) {
            request.signal?.throwIfAborted();
          }
        }
      : undefined;
  assertCurrent?.();
  const boundGateway = resolveGatewayContext
    ? bindInProcessGatewayContext(method, resolveGatewayContext)
    : undefined;
  if (forceTransport || !getInProcessGatewayRequestContext(boundGateway?.resolve)) {
    if (readInProcessSubagentResume(request)) {
      throw new Error("Task resume requires trusted in-process Gateway dispatch.");
    }
    if (runtimeIdentity) {
      throw new Error("trusted agent runtime identity requires in-process Gateway dispatch");
    }
    if (boundGateway && !forceTransport) {
      throw new Error(`Gateway instance unavailable for ${method}`);
    }
    const { callGateway } = await import("../../gateway/call.js");
    const {
      agentRunTracking: _agentRunTracking,
      agentToolCaller: _agentToolCaller,
      ...wireRequest
    } = request;
    return await runBoundInProcessGatewayCall(
      boundGateway,
      () => callGateway<T>({ ...wireRequest, method }),
      assertCurrent,
      revalidateOnCompletion,
    );
  }
  const scopes =
    request.scopes ?? resolveLeastPrivilegeOperatorScopesForMethod(method, request.params);
  const timeoutMs =
    request.timeoutMs === null
      ? undefined
      : (request.timeoutMs ?? DEFAULT_IN_PROCESS_GATEWAY_REQUEST_TIMEOUT_MS);
  const dispatchOptions = {
    forceSyntheticClient: true,
    operatorRoleActor: { kind: "system" as const },
    ...(request.agentRunTracking ? { agentRunTracking: request.agentRunTracking } : {}),
    ...(request.agentToolCaller ? { agentToolCaller: request.agentToolCaller } : {}),
    syntheticScopes: scopes,
    ...(request.expectFinal !== undefined ? { expectFinal: request.expectFinal } : {}),
    ...(request.onAccepted ? { onAccepted: request.onAccepted } : {}),
    ...(request.onSignalAbort
      ? {
          onSignalAbort: () =>
            runWithGatewayToolCleanupContext(
              () =>
                request.onSignalAbort?.((cleanupMethod, params, options) =>
                  callAgentToolGatewayRequestBound(
                    { method: cleanupMethod, params, ...options },
                    boundGateway?.resolve ?? resolveGatewayContext,
                    undefined,
                    undefined,
                  ),
                ),
              boundGateway?.resolve ?? resolveGatewayContext,
            ),
        }
      : {}),
    // A commit receipt owns settlement; cancellation still fences dispatch, commit, and uncommitted results.
    ...(request.signal && revalidateOnCompletion && !completion ? { signal: request.signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(boundGateway ? { resolveGatewayContext: boundGateway.resolve } : {}),
    ...(assertCurrent ? { sessionMutationCommitGuard: assertCurrent } : {}),
  };
  return await runBoundInProcessGatewayCall(
    boundGateway,
    async () =>
      await dispatchGatewayMethodInProcess<T>(
        method,
        (request.params ?? {}) as Record<string, unknown>,
        bindInProcessSubagentResume(
          withInProcessAgentRuntimeIdentity(dispatchOptions, runtimeIdentity),
          readInProcessSubagentResume(request),
        ),
      ),
    assertCurrent,
    revalidateOnCompletion,
    completion,
  );
}

/** Capture one Gateway and caller for a multi-request operation. */
export function bindAgentToolGatewayRequest(options?: {
  resolveGatewayContext?: GatewayContextResolver;
  hostedOnly?: boolean;
  /** Submitted writes retain their outcome; every dispatch still checks the caller. */
  revalidateOnCompletion?: boolean;
}): AgentToolGatewayRequestCaller {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolver =
    callerGatewayContextResolver(options?.resolveGatewayContext) ?? scope?.resolveGatewayContext;
  const admitted = getInProcessGatewayRequestContext(resolver);
  const resolveGatewayContext = resolver
    ? () => (resolver() === admitted ? admitted : undefined)
    : admitted
      ? () => admitted
      : undefined;
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const runInCallerContext = AsyncLocalStorage.snapshot();
  return async <T>(request: AgentToolGatewayRequest): Promise<T> =>
    await runInCallerContext(() =>
      callAgentToolGatewayRequestBound<T>(
        request,
        resolveGatewayContext,
        agentToolGatewayRuntimeIdentities.get(request),
        assertCallerCurrent,
        (!resolver && !admitted) ||
          (options?.hostedOnly === true && admitted?.localEmbedded === true),
        options?.revalidateOnCompletion,
      ),
    );
}

export const callAgentToolGatewayRequest: AgentToolGatewayRequestCaller = async <T>(
  request: AgentToolGatewayRequest,
): Promise<T> => await bindAgentToolGatewayRequest()<T>(request);

async function callInProcessGatewayToolBound<T>(
  method: string,
  params: Record<string, unknown>,
  options: InProcessGatewayCallOptions & {
    sessionCreation?: TrustedSessionCreation;
  },
  fallback: (scopes: ReturnType<typeof resolveLeastPrivilegeOperatorScopesForMethod>) => Promise<T>,
): Promise<T> {
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  const caller = getGatewayToolCallerIdentity();
  const agentToolCaller =
    options.sessionCreation?.via === "spawn" && caller && assertCallerCurrent
      ? {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          assertCurrent: assertCallerCurrent,
        }
      : undefined;
  assertCallerCurrent?.();
  const sessionMutationCommitGuard = assertCallerCurrent
    ? () => {
        assertCallerCurrent();
        options.sessionMutationCommitGuard?.();
      }
    : options.sessionMutationCommitGuard;
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(method, params);
  const resolveGatewayContext = callerGatewayContextResolver(options.resolveGatewayContext);
  const boundGateway = resolveGatewayContext
    ? bindInProcessGatewayContext(method, resolveGatewayContext)
    : undefined;
  if (getInProcessGatewayRequestContext(boundGateway?.resolve)) {
    return await runBoundInProcessGatewayCall(
      boundGateway,
      async (boundResolver) =>
        await dispatchGatewayMethodInProcess<T>(method, params, {
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" as const },
          syntheticScopes: scopes,
          ...(agentToolCaller ? { agentToolCaller } : {}),
          ...(options.sessionCreation ? { sessionCreation: options.sessionCreation } : {}),
          ...(sessionMutationCommitGuard ? { sessionMutationCommitGuard } : {}),
          ...(options.onExecution ? { onExecution: options.onExecution } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs !== undefined && options.timeoutMs !== null
            ? { timeoutMs: options.timeoutMs }
            : {}),
          ...(boundResolver ? { resolveGatewayContext: boundResolver } : {}),
        }),
      assertCallerCurrent,
    );
  }
  if (boundGateway) {
    throw new Error(`Gateway instance unavailable for ${method}`);
  }
  return await runBoundInProcessGatewayCall(undefined, () => fallback(scopes), assertCallerCurrent);
}

export const callInProcessGatewayTool: InProcessGatewayCaller = async <T>(
  method: string,
  params: Record<string, unknown>,
  options: InProcessGatewayCallOptions = {},
): Promise<T> => {
  return await callInProcessGatewayToolBound(method, params, options, async (scopes) =>
    callGatewayTool<T>(
      method,
      options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs },
      params,
      {
        scopes,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    ),
  );
};

export async function callInProcessGatewayToolWithCreation<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  creation: TrustedSessionCreation,
  options: {
    resolveGatewayContext?: GatewayContextResolver;
    sessionMutationCommitGuard?: () => void;
    signal?: AbortSignal;
    timeoutMs?: number | null;
  } = {},
): Promise<T> {
  return await callInProcessGatewayToolBound(
    method,
    params,
    { ...options, sessionCreation: creation },
    async (scopes) => {
      // The fallback is a real local Gateway request. Carry spawn policy only in
      // the signed agent-runtime identity token, never in model-authored params.
      if (creation.via !== "spawn" || !creation.inheritedToolPolicy) {
        return await callGatewayTool<T>(method, {}, params, {
          scopes,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      }
      return await runWithGatewaySessionSpawnContext(
        {
          ...(creation.completionOwnerSessionKey
            ? { completionOwnerSessionKey: creation.completionOwnerSessionKey }
            : {}),
          inheritedToolPolicy: creation.inheritedToolPolicy,
          ...(creation.resolvedModel ? { resolvedModel: creation.resolvedModel } : {}),
          ...(creation.spawnModelAutoSelection
            ? { spawnModelAutoSelection: creation.spawnModelAutoSelection }
            : {}),
        },
        () =>
          callGatewayTool<T>(method, {}, params, {
            scopes,
            requireAgentRuntimeIdentity: true,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          }),
      );
    },
  );
}
