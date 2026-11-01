import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { withoutGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import {
  GATEWAY_NATIVE_APPROVAL_METHODS,
  type GatewayNativeApprovalMethod,
} from "../infra/approval-gateway-runtime-methods.js";
import type {
  GatewayApprovalEventSubscriber,
  GatewayApprovalRequest,
  GatewayApprovalResolved,
} from "../infra/approval-gateway-runtime.types.js";
import { createApprovalNativeRouteCoordinator } from "../infra/approval-native-route-coordinator.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
// HTTP agent ingress can finish before the lazy agent.wait handler loads its recorder.
import "./agent-turn/agent-job.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import type { InternalAgentTurnPrincipalOptions } from "./agent-turn/internal-facade.types.js";
import { retainInternalApprovalCommitGuard } from "./internal-approval-authority.js";
import { createLifecycleTypingManager } from "./lifecycle-typing.js";
import {
  resolveLeastPrivilegeOperatorScopesForMethod,
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  WRITE_SCOPE,
} from "./method-scopes.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayInstanceRuntime,
  GatewayLifecycleRuntime,
  GatewayLifecycleSessionMethod,
} from "./server-instance-runtime.types.js";
import { registerGatewayLifecycleRuntime } from "./server-lifecycle-runtime-context.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  cancelSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

const loadLifecycleTypingAdapter = createLazyRuntimeModule(
  () => import("../channels/plugins/index.js"),
);

const loadOutboundMessageRuntime = createLazyRuntimeModule(
  () => import("../infra/outbound/message.js"),
);

// Persisted outbound notice IDs retain their namespace for delivery deduplication.
const LIFECYCLE_NOTICE_COMPLETION_RETENTION = {
  idPrefix: "main-session-restart-recovery:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

type GatewayInstanceRuntimeOptions = {
  getContext: () => GatewayRequestContext;
  getMethodRegistry: () => GatewayMethodRegistry;
  isDispatchAvailable: () => boolean;
  logError?: (message: string) => void;
};

/** Creates closed internal principals bound to one concrete Gateway lifecycle. */
export function createGatewayInstanceRuntime(
  options: GatewayInstanceRuntimeOptions,
): GatewayInstanceRuntime {
  const approvalSubscribers = new Set<GatewayApprovalEventSubscriber>();
  const routeCoordinator = createApprovalNativeRouteCoordinator();
  let closed = false;
  const lifecycleTyping = createLifecycleTypingManager({
    isAvailable: () => !closed && options.isDispatchAvailable(),
    getConfig: () => options.getContext().getRuntimeConfig(),
    resolveAdapter: async (channel) =>
      (await loadLifecycleTypingAdapter()).getLoadedChannelPlugin(channel)?.heartbeat,
    onError: () => options.logError?.("lifecycle typing unavailable; final delivery continues"),
  });

  const assertDispatchAvailable = (method: string) => {
    if (closed || !options.isDispatchAvailable()) {
      throw new GatewayDispatchUnavailableError(method, !closed);
    }
  };

  const createAgentTurnFacade = (principal: InternalAgentTurnPrincipalOptions) => {
    const assertContextCurrent = () => {
      assertDispatchAvailable("agent turn");
      principal.assertContextCurrent?.();
    };
    return createInternalAgentTurnFacade({
      ...principal,
      assertContextCurrent,
      getContext: options.getContext,
      getMethodRegistry: options.getMethodRegistry,
    });
  };

  const dispatch = async <T>(params: {
    allowedMethods: ReadonlySet<string>;
    client: ReturnType<typeof createSyntheticPluginRuntimeClient>;
    method: string;
    payload: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  }): Promise<T> => {
    assertDispatchAvailable(params.method);
    if (!params.allowedMethods.has(params.method)) {
      throw new Error(`Gateway internal principal cannot dispatch ${params.method}`);
    }
    const context = options.getContext();
    const assertCurrent = () => {
      assertDispatchAvailable(params.method);
      if (options.getContext() !== context) {
        throw new Error(`Gateway instance dispatch unavailable for ${params.method}`);
      }
      params.assertCurrent?.();
    };
    assertCurrent();
    // These closed principals own accepted lifecycle/approval work independently of a turn.
    const result = await withoutGatewayToolCallerIdentity(() =>
      dispatchGatewayRequestInProcess<T>(params.method, params.payload, {
        client: params.client,
        context,
        methodRegistry: options.getMethodRegistry(),
        requestIdPrefix: "gateway-internal",
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        sessionMutationCommitGuard: retainInternalApprovalCommitGuard(assertCurrent),
      }),
    );
    assertCurrent();
    return result;
  };

  const approvalClient = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "system" },
    scopes: [APPROVALS_SCOPE],
  });
  const approvalMethods = new Set<GatewayNativeApprovalMethod>(GATEWAY_NATIVE_APPROVAL_METHODS);
  const approvalRouteClient = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "system" },
    scopes: [WRITE_SCOPE],
  });
  const approvalRouteMethods = new Set(["send"]);

  const lifecycleSessionMethods = new Set<GatewayLifecycleSessionMethod>([
    "chat.history",
    "chat.abort",
    "sessions.delete",
  ]);
  const lifecycleAgentTurns = createAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: [WRITE_SCOPE],
    }),
  });
  const lifecycle: GatewayLifecycleRuntime = {
    dispatchSessionMethod: (method, payload, requestOptions = {}) =>
      dispatch({
        allowedMethods: lifecycleSessionMethods,
        client: createSyntheticPluginRuntimeClient({
          operatorRoleActor: { kind: "system" },
          scopes:
            method === "chat.abort"
              ? [ADMIN_SCOPE]
              : resolveLeastPrivilegeOperatorScopesForMethod(method, payload),
        }),
        method,
        payload,
        ...requestOptions,
      }),
    startTyping: (params) => lifecycleTyping.start(params),
    dispatchAgent: async <T>(
      payload: AgentRunRequest,
      timeoutMs?: number,
      dispatchOptions: GatewayInstanceAgentDispatchOptions = {},
    ) => {
      assertDispatchAvailable("agent");
      const context = options.getContext();
      const operatorAuthority = dispatchOptions.operatorRunAuthority;
      if (operatorAuthority) {
        assertAdmittedRunOperatorAuthority(operatorAuthority);
        operatorAuthority.assertCurrent();
      }
      const releaseOperatorAuthority = operatorAuthority?.retain?.();
      let delegatedToolPolicyHandoffId: string | undefined;
      try {
        delegatedToolPolicyHandoffId = dispatchOptions.delegatedToolPolicyHandoff
          ? registerSubagentCompletionToolHandoff(dispatchOptions.delegatedToolPolicyHandoff)
          : undefined;
        const needsDedicatedPrincipal = Boolean(
          dispatchOptions.allowModelOverride === true ||
          dispatchOptions.allowSyntheticModelOverride === true ||
          dispatchOptions.allowSyntheticCronRunContinuation === true ||
          dispatchOptions.runtimeContextFragments ||
          dispatchOptions.internalDeliverySuppressErrors === true ||
          delegatedToolPolicyHandoffId ||
          operatorAuthority ||
          dispatchOptions.agentToolCaller ||
          dispatchOptions.scopes ||
          dispatchOptions.syntheticScopes,
        );
        const assertContextCurrent = () => {
          assertDispatchAvailable("agent");
          if (options.getContext() !== context) {
            throw new Error("Gateway lifecycle context changed.");
          }
        };
        const agentTurns = needsDedicatedPrincipal
          ? createAgentTurnFacade({
              client: createSyntheticPluginRuntimeClient({
                operatorRoleActor: operatorAuthority
                  ? { kind: "operator", profileId: operatorAuthority.profileId }
                  : { kind: "system" },
                operatorRunAuthority: operatorAuthority,
                agentToolCaller: dispatchOptions.agentToolCaller,
                allowModelOverride:
                  dispatchOptions.allowModelOverride === true ||
                  dispatchOptions.allowSyntheticModelOverride === true,
                cronRunContinuation: dispatchOptions.allowSyntheticCronRunContinuation === true,
                runtimeContextFragments: dispatchOptions.runtimeContextFragments,
                internalDeliverySuppressErrors: dispatchOptions.internalDeliverySuppressErrors,
                delegatedToolPolicyHandoffId,
                scopes: operatorAuthority
                  ? [...operatorAuthority.scopes]
                  : (dispatchOptions.scopes ?? dispatchOptions.syntheticScopes),
              }),
              assertContextCurrent,
            })
          : lifecycleAgentTurns;
        return await agentTurns.dispatch<T>(payload, {
          controllerInput: dispatchOptions.controllerInput,
          replyExpectation: dispatchOptions.replyExpectation,
          assertAdmissionCurrent: () => {
            assertContextCurrent();
            dispatchOptions.assertAdmissionCurrent?.();
          },
          assertCancellationCurrent: () => {
            assertContextCurrent();
            dispatchOptions.signal?.throwIfAborted();
            dispatchOptions.assertAdmissionCurrent?.();
            operatorAuthority?.assertCurrent();
          },
          executionSource: dispatchOptions.executionSource,
          prepareDispatchCurrent: dispatchOptions.prepareDispatchCurrent,
          expectFinal: dispatchOptions.expectFinal,
          onAccepted: dispatchOptions.onAccepted,
          onStartOwner: dispatchOptions.onStartOwner,
          onExecutionStarted: dispatchOptions.onExecutionStarted,
          onSignalAbort: dispatchOptions.onSignalAbort,
          signal: dispatchOptions.signal,
          timeoutMs,
        });
      } finally {
        cancelSubagentCompletionToolHandoff(delegatedToolPolicyHandoffId);
        releaseOperatorAuthority?.();
      }
    },
    waitForAgent: async <T>(payload: AgentWaitParams, timeoutMs?: number, signal?: AbortSignal) => {
      assertDispatchAvailable("agent.wait");
      return await lifecycleAgentTurns.wait<T>(payload, timeoutMs, signal);
    },
    sendNotice: async (payload) => {
      if (closed || !options.isDispatchAvailable()) {
        throw new Error("Gateway instance dispatch unavailable for lifecycle notice");
      }
      const { sendMessage } = await loadOutboundMessageRuntime();
      const assertNoticeCurrent = () => {
        if (
          closed ||
          !options.isDispatchAvailable() ||
          payload.isCurrent?.(options.getContext().getRuntimeConfig()) === false
        ) {
          throw new Error("Lifecycle notice owner retired before delivery");
        }
      };
      assertNoticeCurrent();
      const context = options.getContext();
      const result = await sendMessage({
        cfg: context.getRuntimeConfig(),
        deps: createOutboundSendDeps(context.deps),
        channel: payload.channel,
        to: payload.to,
        accountId: payload.accountId,
        threadId: payload.threadId,
        content: payload.text,
        gatewayOwnedDelivery: true,
        bestEffort: true,
        idempotencyKey: payload.idempotencyKey,
        deliveryIntentId: payload.idempotencyKey,
        reusePendingDeliveryIntent: true,
        completionRetention: LIFECYCLE_NOTICE_COMPLETION_RETENTION,
        onPlatformSendDispatch: async () => assertNoticeCurrent(),
        // Provider throttles may wait after the asynchronous dispatch check.
        assertDirectAdapterHandoff: assertNoticeCurrent,
        abortSignal: AbortSignal.timeout(10_000),
      });
      if (result.deliveryStatus === "failed" || result.deliveryStatus === "partial_failed") {
        throw new Error(result.error ?? "lifecycle notice delivery failed");
      }
      return { suppressed: result.deliveryStatus === "suppressed" };
    },
  };
  const releaseLifecycleRuntime = registerGatewayLifecycleRuntime(lifecycle);

  const pendingApprovalPublications = new Map<string, Set<symbol>>();
  const publishRequestedAsync = async (
    kind: ChannelApprovalKind,
    request: GatewayApprovalRequest,
  ): Promise<number> => {
    if (closed) {
      return 0;
    }
    const publication = Symbol("approval publication");
    const publications = pendingApprovalPublications.get(request.id) ?? new Set<symbol>();
    publications.add(publication);
    pendingApprovalPublications.set(request.id, publications);
    let delivered = 0;
    try {
      for (const subscriber of Array.from(approvalSubscribers)) {
        if (!subscriber.eventKinds.has(kind)) {
          continue;
        }
        try {
          if (!(await subscriber.shouldHandle(request))) {
            continue;
          }
          // Resolution, unsubscription, or Gateway close can retire delivery while eligibility waits.
          if (closed || pendingApprovalPublications.get(request.id) !== publications) {
            break;
          }
          if (!approvalSubscribers.has(subscriber)) {
            continue;
          }
          subscriber.onRequested(request);
          delivered += 1;
        } catch (error) {
          options.logError?.(`internal approval subscriber failed: ${String(error)}`);
        }
      }
    } finally {
      publications.delete(publication);
      if (!publications.size && pendingApprovalPublications.get(request.id) === publications) {
        pendingApprovalPublications.delete(request.id);
      }
    }
    return delivered;
  };

  const publish = (
    kind: ChannelApprovalKind,
    callback: (subscriber: GatewayApprovalEventSubscriber) => void,
    shouldDeliver?: (subscriber: GatewayApprovalEventSubscriber) => boolean,
  ): number => {
    if (closed) {
      return 0;
    }
    let delivered = 0;
    for (const subscriber of approvalSubscribers) {
      if (!subscriber.eventKinds.has(kind)) {
        continue;
      }
      try {
        if (shouldDeliver && !shouldDeliver(subscriber)) {
          continue;
        }
        callback(subscriber);
        delivered += 1;
      } catch (error) {
        options.logError?.(`internal approval subscriber failed: ${String(error)}`);
      }
    }
    return delivered;
  };

  return {
    createAgentTurnFacade,
    approvalEvents: {
      publishRequested: (kind, request) => {
        warnPluginSdkDeprecation({
          family: "approval-event-publication",
          method: "approvalEvents.publishRequested",
          replacement: "await approvalEvents.publishRequestedAsync",
          compatibility: "Synchronous subscribers retain immediate delivery and numeric counts.",
        });
        if (closed) {
          return 0;
        }
        // SAFETY: Gateway publishers pass the canonical normalized approval request union.
        const approvalRequest = request as GatewayApprovalRequest;
        const eligible = new Set<GatewayApprovalEventSubscriber>();
        for (const subscriber of Array.from(approvalSubscribers)) {
          if (!subscriber.eventKinds.has(kind)) {
            continue;
          }
          let accepted: boolean | Promise<boolean>;
          try {
            accepted = subscriber.shouldHandle(approvalRequest);
          } catch (error) {
            options.logError?.(`internal approval subscriber failed: ${String(error)}`);
            continue;
          }
          if (typeof accepted !== "boolean") {
            // Observe started preparation even though this publication cannot await it.
            void accepted.catch((error: unknown) => {
              options.logError?.(`internal approval subscriber failed: ${String(error)}`);
            });
            throw new Error(
              "Approval eligibility requires async preparation; use approvalEvents.publishRequestedAsync.",
            );
          }
          if (accepted) {
            eligible.add(subscriber);
          }
        }
        return publish(
          kind,
          (subscriber) => subscriber.onRequested(approvalRequest),
          (subscriber) => eligible.has(subscriber),
        );
      },
      publishRequestedAsync: (kind, request) =>
        publishRequestedAsync(kind, request as GatewayApprovalRequest),
      publishResolved: (kind, resolved) => {
        pendingApprovalPublications.delete((resolved as GatewayApprovalResolved).id);
        publish(kind, (subscriber) => subscriber.onResolved(resolved as GatewayApprovalResolved));
      },
    },
    nativeApprovals: {
      getRuntimeConfig: () => {
        if (closed) {
          throw new Error("Gateway instance approval runtime is closed");
        }
        return options.getContext().getRuntimeConfig();
      },
      request: async <T>(
        method: GatewayNativeApprovalMethod,
        payload: Record<string, unknown>,
        requestOptions?: { clientDisplayName?: string },
      ) =>
        await dispatch<T>({
          allowedMethods: approvalMethods,
          client: requestOptions?.clientDisplayName
            ? {
                ...approvalClient,
                connect: {
                  ...approvalClient.connect,
                  client: {
                    ...approvalClient.connect.client,
                    displayName: requestOptions.clientDisplayName,
                  },
                },
              }
            : approvalClient,
          method,
          payload,
          timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        }),
      requestRoute: async <T>(method: "send", payload: Record<string, unknown>) =>
        await dispatch<T>({
          allowedMethods: approvalRouteMethods,
          client: approvalRouteClient,
          method,
          payload,
          timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        }),
      routeCoordinator,
      subscribe: (subscriber) => {
        if (closed) {
          throw new Error("Gateway instance approval runtime is closed");
        }
        approvalSubscribers.add(subscriber);
        let subscribed = true;
        return () => {
          if (!subscribed) {
            return;
          }
          subscribed = false;
          approvalSubscribers.delete(subscriber);
        };
      },
    },
    lifecycle,
    isAvailable: () => !closed && options.isDispatchAvailable(),
    close: () => {
      closed = true;
      lifecycleTyping.close();
      releaseLifecycleRuntime();
      approvalSubscribers.clear();
      pendingApprovalPublications.clear();
      routeCoordinator.close();
    },
  };
}
