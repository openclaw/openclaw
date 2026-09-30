import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import { captureGatewayToolCallerAssertion } from "../agents/tools/gateway-caller-context.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
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
import { cancelSubagentCompletionToolHandoff } from "./subagent-completion-tool-handoff.js";

export {
  captureOperatorToolGatewayContinuationContext,
  runWithOperatorToolGatewayCleanupContext,
  runWithOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-authority.js";

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
  let operatorSource = await captureGatewayOperatorRunAuthority({
    client: resolved.operatorSourceClient,
    context: resolved.context,
    hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
  });
  const assertLifetime = () => {
    resolved.assertContextCurrent();
    resolved.assertInvocationCurrent();
    operatorSource?.authority.assertCurrent();
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
      const { authorizeGatewayRequestPreDispatch, createRequestGatewayMethodRegistry } =
        await import("./server-methods.js");
      assertLifetime();
      const { error } = await authorizeGatewayRequestPreDispatch({
        method: "agent",
        requestParams: { agentId: params.agentId },
        client,
        context: resolved.context,
        methodRegistry:
          resolved.context.getGatewayMethodRegistry?.() ?? createRequestGatewayMethodRegistry(),
      });
      assertLifetime();
      if (error) {
        unwrapGatewayMethodDispatchResponse("agent", { ok: false, error });
      }
      operatorSource ??= await captureGatewayOperatorRunAuthority({
        client,
        context: resolved.context,
        hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
      });
      assertCurrent();
    },
    run<T>(run: () => Promise<T>): Promise<T> {
      assertCurrent();
      return runOutsideOperatorToolGatewayAuthority(run);
    },
  };
}

export async function withInProcessGatewayDispatch<T>(
  method: string,
  params: unknown,
  options: DispatchGatewayMethodInProcessOptions | undefined,
  run: (resolved: ResolvedInProcessGatewayDispatch) => Promise<T>,
): Promise<T> {
  const resolved = resolveInProcessGatewayDispatch(method, params, options);
  let releaseOperatorAuthority: (() => void) | undefined;
  try {
    const captured = await captureGatewayOperatorRunAuthority({
      client: resolved.operatorSourceClient,
      context: resolved.context,
      hasCurrentClientAuthority: resolved.hasCurrentClientAuthority,
    });
    releaseOperatorAuthority = captured?.release;
    resolved.assertContextCurrent();
    resolved.assertInvocationCurrent();
    captured?.authority.assertCurrent();
    if (captured) {
      resolved.client = mergePluginRuntimeClientInternal(resolved.client, {
        operatorRunAuthority: captured.authority,
      });
      const assertSourceCurrent = resolved.assertSourceCurrent;
      resolved.assertSourceCurrent = () => {
        assertSourceCurrent();
        captured.authority.assertCurrent();
      };
      const assertContextCurrent = resolved.assertContextCurrent;
      resolved.assertContextCurrent = () => {
        assertContextCurrent();
        captured.authority.assertCurrent();
      };
      const assertCreatedInputSourceCurrent = resolved.assertCreatedInputSourceCurrent;
      if (assertCreatedInputSourceCurrent) {
        resolved.assertCreatedInputSourceCurrent = () => {
          assertCreatedInputSourceCurrent();
          captured.authority.assertCurrent();
        };
      }
    }
    // A launched agent is autonomous; retaining tool-call AsyncLocalStorage would
    // leak the human authority into later model-selected work after closure.
    return method === "agent" && readOperatorToolGatewayAuthority()
      ? await runOutsideOperatorToolGatewayAuthority(() => run(resolved))
      : await run(resolved);
  } finally {
    releaseOperatorAuthority?.();
    cancelSubagentCompletionToolHandoff(resolved.delegatedToolPolicyHandoffId);
  }
}

export type { GatewayMethodDispatchResponse } from "./server-in-process-dispatch.js";

/** Local session input uses the same authorization and commit fences as an agent RPC. */
export async function runWithInProcessGatewaySessionMutation<T>(
  params: { sessionKey: string; agentId?: string },
  run: (assertCurrent: () => void) => Promise<T> | T,
): Promise<T> {
  const assertCallerCurrent = captureGatewayToolCallerAssertion();
  return await withInProcessGatewayDispatch(
    "agent",
    params,
    { forceSyntheticClient: true, syntheticScopeMode: "minimum" },
    async (resolved) => {
      const { authorizeGatewayRequestPreDispatch, createRequestGatewayMethodRegistry } =
        await import("./server-methods.js");
      const assertInvocationCurrent = () => {
        assertCallerCurrent?.("agent");
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
      };
      assertInvocationCurrent();
      const authorization = await authorizeGatewayRequestPreDispatch({
        method: "agent",
        requestParams: params,
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
            unwrapGatewayMethodDispatchResponse("agent", {
              ok: false,
              error: authorization.error,
            });
          }
          authorization.sessionMutationAuthorization?.assertCurrent();
          authorization.sessionAccessAuthority?.assertCurrent();
        };
        assertCurrent();
        return await run(assertCurrent);
      } finally {
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
    const assertExplicitRequestCurrent = () => {
      throwIfGatewayDispatchAborted(method, options?.signal);
      if (resolved.hasCurrentClientAuthority?.() === false) {
        throw new Error(`Gateway client authority closed before dispatching ${method}.`);
      }
      options?.sessionMutationCommitGuard?.();
    };
    const assertCreatedInputSourceCurrent = resolved.assertCreatedInputSourceCurrent;
    return await dispatchGatewayRequestInProcessRaw(method, params, {
      client: resolved.client,
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
      sessionMutationCommitGuard: () => {
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
        // Nested RPCs keep the original request owner through preparation and final I/O.
        assertExplicitRequestCurrent();
      },
      ...(assertCreatedInputSourceCurrent
        ? {
            assertCreatedInputSourceCurrent: () => {
              assertCreatedInputSourceCurrent();
              assertExplicitRequestCurrent();
            },
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
        // Admission below still checks the selecting turn. Accepted executions
        // outlive that turn while retaining its operator source and Gateway owner.
        assertContextCurrent:
          method === "agent" ? resolved.assertSourceCurrent : resolved.assertContextCurrent,
        client: resolved.client,
        isWebchatConnect: resolved.isWebchatConnect,
      });
      return method === "agent"
        ? await facade.dispatch<T>(params as AgentRunRequest, {
            prepareDispatchCurrent: options?.prepareDispatchCurrent,
            assertAdmissionCurrent: () => {
              resolved.assertInvocationCurrent();
              options?.sessionMutationCommitGuard?.();
            },
            privateCompletion: options?.privateCompletion,
            settleWakeReplay: options?.settleWakeReplay,
            cancelOnDeadline: options?.cancelOnDeadline,
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
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
