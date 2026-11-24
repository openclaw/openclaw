import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import { readQuestionDispatchCapability } from "../agents/harness/host-private-capabilities.js";
import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context-store.js";
import { isGatewayWorkerApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.types.js";
import {
  hasPreparedGatewayDeviceAuthority,
  readGatewayDeviceRevocationGuard,
} from "./device-revocation.js";
import {
  isInternalApprovalCommitGuard,
  retainInternalApprovalCommitGuard,
} from "./internal-approval-authority.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  readOperatorToolGatewayAuthority,
  runOutsideOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import {
  dispatchGatewayRequestInProcessRaw,
  type GatewayMethodDispatchResponse,
  throwIfGatewayDispatchAborted,
  unwrapGatewayMethodDispatchResponse,
} from "./server-in-process-dispatch.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import { resolveInProcessGatewayDispatch } from "./server-plugin-in-process-authority.js";
import type {
  DispatchGatewayMethodInProcessOptions,
  PrepareInProcessAgentExecutionOptions,
  ResolvedInProcessGatewayDispatch,
} from "./server-plugin-in-process-dispatch.types.js";
import { mergePluginRuntimeClientInternal } from "./server-plugin-runtime-client.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { cancelSubagentCompletionToolHandoff } from "./subagent-completion-tool-handoff.js";

export {
  captureOperatorToolGatewayContinuationContext,
  runWithOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-authority.js";
export { captureOperatorToolGatewayRequestContinuationContext } from "./server-plugin-in-process-request-continuation.js";
export { runWithOperatorToolGatewayCleanupContext } from "./server-plugin-runtime-client.js";

/** Authorizes a sessionless agent execution against its captured Gateway and caller. */
export async function prepareInProcessAgentExecution(input: PrepareInProcessAgentExecutionOptions) {
  const params = { ...input };
  const inheritedAuthority = readOperatorToolGatewayAuthority();
  const resolved = resolveInProcessGatewayDispatch(
    "agent",
    { agentId: params.agentId },
    {
      agentRunTracking: "plugin_subagent",
      pluginRuntimeOwnerId: params.pluginRuntimeOwnerId,
      resolveGatewayContext: params.resolveGatewayContext,
    },
  );
  // Profile verification updates the original connection. Sessionless work needs
  // that live principal, not the dispatch copy carrying session tracking metadata.
  const client = getPluginRuntimeGatewayRequestScope()?.client ?? resolved.client;
  let operatorSource = await prepareGatewayOperatorRunAuthority({
    client: resolved.operatorSourceClient,
    context: resolved.context,
    hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
  });
  const assertLifetime = () => {
    resolved.assertContextCurrent();
    resolved.assertInvocationCurrent();
  };
  const assertCurrent = () => {
    assertLifetime();
    const error = authorizeGatewaySessionCreation({
      cfg: resolved.context.getRuntimeConfig(),
      agentId: params.agentId,
      client,
    });
    if (error) {
      unwrapGatewayMethodDispatchResponse("agent", { ok: false, error });
    }
  };
  try {
    assertLifetime();
  } catch (error) {
    operatorSource?.release();
    throw error;
  }
  return {
    context: resolved.context,
    get operatorAuthority() {
      return operatorSource?.authority;
    },
    get signal() {
      return operatorSource?.authority.signal
        ? inheritedAuthority
          ? AbortSignal.any([inheritedAuthority.signal, operatorSource.authority.signal])
          : operatorSource.authority.signal
        : inheritedAuthority?.signal;
    },
    release: () => operatorSource?.release(),
    assertCurrent,
    async authorize() {
      assertLifetime();
      const [{ authorizeGatewayRequestPreDispatch }, { createRequestGatewayMethodRegistry }] =
        await Promise.all([
          import("./server-methods/request-authorization.js"),
          import("./server-methods.js"),
        ]);
      assertLifetime();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method: "agent",
        requestParams: { agentId: params.agentId },
        client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
      });
      authorization.sessionMutationAuthorization?.release?.();
      authorization.sessionAccessAuthority?.release();
      assertLifetime();
      if (authorization.error) {
        unwrapGatewayMethodDispatchResponse("agent", { ok: false, error: authorization.error });
      }
      operatorSource ??= await prepareGatewayOperatorRunAuthority({
        client,
        context: resolved.context,
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
      });
      assertCurrent();
    },
    run<T>(run: () => Promise<T>): Promise<T> {
      assertCurrent();
      return runWithoutOwnedSessionTranscriptWrites(() =>
        runOutsideOperatorToolGatewayAuthority(run),
      );
    },
  };
}

export async function withInProcessGatewayDispatch<T>(
  method: string,
  params: unknown,
  options: DispatchGatewayMethodInProcessOptions | undefined,
  run: (resolved: ResolvedInProcessGatewayDispatch) => Promise<T>,
): Promise<T> {
  let releaseOperatorAuthority: (() => void) | undefined;
  let delegatedToolPolicyHandoffId: ResolvedInProcessGatewayDispatch["delegatedToolPolicyHandoffId"];
  let preparationComplete = false;
  try {
    const resolved = resolveInProcessGatewayDispatch(method, params, options);
    delegatedToolPolicyHandoffId = resolved.delegatedToolPolicyHandoffId;
    const captured = await prepareGatewayOperatorRunAuthority({
      client: resolved.operatorSourceClient,
      context: resolved.context,
      hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
    });
    releaseOperatorAuthority = captured?.release;
    resolved.assertContextCurrent();
    resolved.assertInvocationCurrent();
    if (captured) {
      resolved.client = mergePluginRuntimeClientInternal(resolved.client, {
        operatorRunAuthority: captured.authority,
      });
    }
    // Only preparation refusals prove method work was never entered. Errors
    // from the callback may follow effects and must retain their original form.
    preparationComplete = true;
    // Autonomous turns establish their own transcript writer and must not retain
    // the caller's tool authority after that invocation closes.
    return method === "agent"
      ? await runWithoutOwnedSessionTranscriptWrites(() =>
          runOutsideOperatorToolGatewayAuthority(() =>
            withoutGatewayToolCallerIdentity(() => run(resolved)),
          ),
        )
      : await run(resolved);
  } catch (error) {
    if (!preparationComplete && error instanceof SessionMutationAuthorizationChangedError) {
      // Match the ordinary router's structured refusal before handler entry.
      unwrapGatewayMethodDispatchResponse(method, { ok: false, error: error.error });
    }
    throw error;
  } finally {
    releaseOperatorAuthority?.();
    cancelSubagentCompletionToolHandoff(delegatedToolPolicyHandoffId);
  }
}

export type { GatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

export function withInProcessGatewayRead<T>(
  params: {
    method: "sessions.list" | "users.list" | "sessions.get";
    requestParams?: { key: string };
    scope: PluginRuntimeGatewayRequestScope | undefined;
    resolveGatewayContext?: DispatchGatewayMethodInProcessOptions["resolveGatewayContext"];
    callerAuthorityError: string;
  },
  run: (resolved: ResolvedInProcessGatewayDispatch, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const { method, scope } = params;
  return withInProcessGatewayDispatch(
    method,
    params.requestParams ?? {},
    {
      forceSyntheticClient: true,
      pluginRuntimeOwnerId: scope?.pluginId,
      resolveGatewayContext: params.resolveGatewayContext,
      syntheticScopes: ["operator.read"],
      ...(!scope?.client ? { operatorRoleActor: { kind: "system" as const } } : {}),
    },
    async (resolved) => {
      const assertLifetime = () => {
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
        scope?.signal?.throwIfAborted();
        if (resolved.hasCurrentClientAuthority?.() === false) {
          throw new Error(params.callerAuthorityError);
        }
      };
      const [{ authorizeGatewayRequestPreDispatch }, { createRequestGatewayMethodRegistry }] =
        await Promise.all([
          import("./server-methods/request-authorization.js"),
          import("./server-methods.js"),
        ]);
      assertLifetime();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method,
        requestParams: params.requestParams ?? {},
        client: resolved.client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
        assertInvocationCurrent: assertLifetime,
      });
      try {
        const assertCurrent = () => {
          assertLifetime();
          if (authorization.error) {
            throw new Error(authorization.error.message);
          }
          authorization.sessionAccessAuthority?.assertCurrent();
          authorization.sessionMutationAuthorization?.assertCurrent();
        };
        assertCurrent();
        const assertReadCurrent =
          method === "sessions.get" && params.requestParams
            ? await (
                await import("./server-plugin-in-process-session-read.js")
              ).prepareInProcessSessionRead(resolved, params.requestParams.key, assertCurrent)
            : assertCurrent;
        assertReadCurrent();
        return await run(resolved, assertReadCurrent);
      } finally {
        authorization.sessionMutationAuthorization?.release?.();
        authorization.sessionAccessAuthority?.release();
      }
    },
  );
}

/** Local session input retains its operation's authorization and commit fences. */
export async function runWithInProcessGatewaySessionMutation<T>(
  params: {
    sessionKey: string;
    agentId?: string;
    resolveGatewayContext?: DispatchGatewayMethodInProcessOptions["resolveGatewayContext"];
  },
  run: (
    assertCurrent: () => void,
    context: ResolvedInProcessGatewayDispatch["context"],
  ) => Promise<T> | T,
): Promise<T> {
  const method = "sessions.send";
  const requestParams = { key: params.sessionKey, agentId: params.agentId };
  return await withInProcessGatewayDispatch(
    method,
    requestParams,
    {
      forceSyntheticClient: true,
      syntheticScopeMode: "minimum",
      ...(params.resolveGatewayContext
        ? { resolveGatewayContext: params.resolveGatewayContext }
        : {}),
    },
    async (resolved) => {
      const [{ authorizeGatewayRequestPreDispatch }, { createRequestGatewayMethodRegistry }] =
        await Promise.all([
          import("./server-methods/request-authorization.js"),
          import("./server-methods.js"),
        ]);
      const assertInvocationCurrent = () => {
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
      };
      assertInvocationCurrent();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method,
        requestParams,
        client: resolved.client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
        assertInvocationCurrent,
      });
      try {
        const assertCurrent = () => {
          assertInvocationCurrent();
          if (authorization.error) {
            unwrapGatewayMethodDispatchResponse(method, {
              ok: false,
              error: authorization.error,
            });
          }
          // Unlike the public send RPC, local notifications cannot create a session.
          if (!authorization.sessionMutationAuthorization?.admittedTarget) {
            throw new Error("Session target is unavailable for notification.");
          }
          authorization.sessionMutationAuthorization?.assertCurrent();
          authorization.sessionAccessAuthority?.assertCurrent();
        };
        assertCurrent();
        return await run(assertCurrent, resolved.context);
      } finally {
        authorization.sessionMutationAuthorization?.release?.();
        authorization.sessionAccessAuthority?.release();
      }
    },
  );
}

export async function dispatchGatewayMethodInProcessRaw(
  method: string,
  params: unknown,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<GatewayMethodDispatchResponse> {
  return await withInProcessGatewayDispatch(method, params, options, async (resolved) => {
    const assertExplicitCommitCurrent = captureExternalSessionCommitGuard(
      options?.sessionMutationCommitGuard,
    );
    const assertExplicitRequestCurrent = composeSessionSourceAssertion(
      [assertExplicitCommitCurrent],
      (assertSource) => {
        throwIfGatewayDispatchAborted(method, options?.signal);
        if (resolved.hasCurrentClientAuthority?.() === false) {
          throw new Error(`Gateway client authority closed before dispatching ${method}.`);
        }
        assertSource();
      },
      {
        preparedCheck: (assertSource) => {
          throwIfGatewayDispatchAborted(method, options?.signal);
          if (
            !hasPreparedGatewayDeviceAuthority(resolved.client, resolved.hasCurrentClientAuthority)
          ) {
            throw new Error(`Gateway client authority closed before dispatching ${method}.`);
          }
          assertSource();
        },
      },
    );
    // Accepted chat input belongs to its host, independently of this invocation.
    const assertCreatedInputSourceCurrent =
      resolved.assertCreatedInputSourceCurrent ??
      (method === "chat.send" ? resolved.assertSourceCurrent : undefined);
    const sessionMutationCommitGuard = composeSessionSourceAssertion([
      resolved.assertContextCurrent,
      resolved.assertInvocationCurrent,
      assertExplicitRequestCurrent,
    ]);
    if (
      isGatewayWorkerApprovalMethod(method) &&
      (!options?.sessionMutationCommitGuard ||
        isInternalApprovalCommitGuard(options.sessionMutationCommitGuard)) &&
      (!resolved.hasCurrentClientAuthority ||
        readGatewayDeviceRevocationGuard(resolved.hasCurrentClientAuthority))
    ) {
      retainInternalApprovalCommitGuard(sessionMutationCommitGuard);
    }
    return await dispatchGatewayRequestInProcessRaw(method, params, {
      client: resolved.client,
      parentHttpRequestAuthority: resolved.parentHttpRequestAuthority,
      context: resolved.context,
      expectFinal: options?.expectFinal,
      isWebchatConnect: resolved.isWebchatConnect,
      hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
      methodRegistry: resolved.context.getGatewayMethodRegistry?.(),
      onAccepted: options?.onAccepted,
      onExecution: options?.onExecution,
      onSignalAbort: options?.onSignalAbort,
      requestIdPrefix: "plugin-subagent",
      prepareDispatchCurrent: options?.prepareDispatchCurrent,
      assertPreparationCurrent: composeSessionSourceAssertion([
        resolved.assertContextCurrent,
        resolved.assertInvocationCurrent,
      ]),
      sessionMutationCommitGuard,
      questionCallerRead: readQuestionDispatchCapability(options?.prepareDispatchCurrent)
        ?.callerRead,
      ...(assertCreatedInputSourceCurrent
        ? {
            assertCreatedInputSourceCurrent: composeSessionSourceAssertion([
              assertCreatedInputSourceCurrent,
              assertExplicitCommitCurrent,
              options?.signal
                ? () => throwIfGatewayDispatchAborted(method, options.signal)
                : undefined,
            ]),
          }
        : {}),
      timeoutMs: options?.timeoutMs,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  });
}

export { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";

export async function dispatchGatewayMethodInProcess<T>(
  method: string,
  params: Record<string, unknown>,
  options?: DispatchGatewayMethodInProcessOptions,
): Promise<T> {
  if (method === "agent" || method === "agent.wait") {
    return await withInProcessGatewayDispatch(method, params, options, async (resolved) => {
      const createAgentTurnFacade = resolved.context.createAgentTurnFacade;
      if (!createAgentTurnFacade) {
        throw new Error(`Gateway instance agent turn facade unavailable for ${method}`);
      }
      // Plugins may load through another source/bundle graph. Only the captured host can
      // create turns against its published runtime; a local import creates a second owner.
      const facade = await createAgentTurnFacade({
        assertContextCurrent:
          method === "agent" ? resolved.assertGatewayCurrent : resolved.assertContextCurrent,
        client: resolved.client,
        isWebchatConnect: resolved.isWebchatConnect,
      });
      return method === "agent"
        ? await facade.dispatch<T>(params as AgentRunRequest, {
            controllerInput: options?.controllerInput,
            prepareDispatchCurrent: options?.prepareDispatchCurrent,
            assertAdmissionCurrent: composeSessionSourceAssertion([
              // The caller authorizes admission; accepted execution retains its own authority.
              resolved.assertSourceCurrent,
              resolved.assertInvocationCurrent,
              captureExternalSessionCommitGuard(options?.sessionMutationCommitGuard),
            ]),
            privateCompletion: options?.privateCompletion,
            replyExpectation: options?.replyExpectation,
            settleWakeReplay: options?.settleWakeReplay,
            subagentCompletions: options?.subagentCompletions,
            cancelOnDeadline: options?.cancelOnDeadline,
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
            onStartOwner: options?.onStartOwner,
            onExecutionStarted: options?.onExecutionStarted,
            onSignalAbort: options?.onSignalAbort,
            signal: options?.signal,
            timeoutMs: options?.timeoutMs,
          })
        : await facade.wait<T>(
            params as AgentWaitParams,
            options?.timeoutMs,
            options?.signal,
            options?.onSignalAbort,
            options?.prepareDispatchCurrent,
          );
    });
  }
  const response = await dispatchGatewayMethodInProcessRaw(method, params, options);
  return unwrapGatewayMethodDispatchResponse(method, response) as T;
}
