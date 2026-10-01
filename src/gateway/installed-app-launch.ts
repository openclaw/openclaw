import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import {
  InstalledAppLaunchDispatchSchema,
  InstalledAppLaunchReadySchema,
  InstalledAppLaunchWireSchema,
} from "../infra/installed-app-launch.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";
import { resolveNodeInvokeRuntimeAuthorityError } from "./server-methods/nodes.invoke-authority.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { sameWorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

/** Ordinary exec records bind the app revision as well as executable/node/caller. */
export async function prepareInstalledAppForwarding(params: {
  nodeId: string;
  rawParams: unknown;
  client: GatewayClient | null;
  execApprovalManager?: ExecApprovalManager;
}): ReturnType<typeof sanitizeSystemRunParamsForForwarding> {
  const request = InstalledAppLaunchWireSchema.parse(params.rawParams);
  const caller = params.client?.internal?.agentRuntimeIdentity;
  if (
    !caller ||
    request.execution.agentId !== caller.agentId ||
    request.execution.sessionKey !== caller.sessionKey
  ) {
    throw new Error("Installed-app launch requires its original admitted agent and session");
  }
  const result = await sanitizeSystemRunParamsForForwarding({
    ...params,
    rawParams: request.execution,
    installedApp: { appId: request.appId, appRevision: request.appRevision },
  });
  if (!result.ok) {
    return result;
  }
  return {
    ...result,
    params: {
      appId: request.appId,
      appRevision: request.appRevision,
      agentId: caller.agentId,
      execution: result.params,
    },
  };
}

/** The validated request identity owns this boundary across in-process and signed transport. */
export function prepareInstalledAppInvocation(params: {
  nodeId: string;
  rawParams: unknown;
  connId: string;
  context: Pick<
    GatewayRequestContext,
    | "nodeRegistry"
    | "execApprovalManager"
    | "validateAgentRuntimeApprovalAuthority"
    | "workerSessionPlacementService"
  >;
  client: GatewayClient | null;
  approvalAuthority?: Parameters<
    typeof resolveNodeInvokeRuntimeAuthorityError
  >[0]["approvalAuthority"];
}) {
  const action = InstalledAppLaunchDispatchSchema.parse(params.rawParams);
  const caller = params.client?.internal?.agentRuntimeIdentity;
  if (!caller || action.agentId !== caller.agentId) {
    throw new Error("Installed-app launch requires an admitted Gateway agent run");
  }
  // Socket cancellation only closes the RPC observer. The admitted source owns
  // cancellation of accepted node work, including calls over signed transport.
  const controller = new AbortController();
  const authority = caller.delegatedAuthority;
  const stopRun = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
    if (
      closed.claimId === authority.claimId &&
      closed.lifecycleGeneration === authority.lifecycleGeneration &&
      closed.operationalRunInstance.instanceId === authority.operationalRunInstance.instanceId &&
      closed.operationalRunInstance.runId === authority.operationalRunInstance.runId
    ) {
      controller.abort(new Error("Installed-app source authority closed"));
    }
  });
  let stopClaim: (() => void) | undefined;
  try {
    stopClaim =
      authority.kind === "worker"
        ? params.context.workerSessionPlacementService?.registerTurnClaimClosedHandler?.(
            (closed) => {
              if (sameWorkerSessionTurnClaim(closed, authority.turnClaim)) {
                controller.abort(new Error("Installed-app worker source closed"));
              }
            },
          )
        : undefined;
  } catch (error) {
    stopRun();
    throw error;
  }
  let closed = false;
  let invokeId: string | undefined;
  let permitSent = false;
  let reason: string | undefined;
  const isCurrent = () => {
    try {
      if (closed) {
        throw new Error("Installed-app invocation has closed");
      }
      controller.signal.throwIfAborted();
      const error = resolveNodeInvokeRuntimeAuthorityError(params);
      if (error) {
        throw new Error(error);
      }
      params.client?.internal?.operatorRunAuthority?.assertCurrent();
      return true;
    } catch (error) {
      reason = error instanceof Error ? error.message : "Installed-app caller authority closed";
      return false;
    }
  };
  if (!isCurrent()) {
    controller.abort(new Error(reason));
  }
  return {
    signal: controller.signal,
    close: () => {
      closed = true;
      stopRun();
      stopClaim?.();
    },
    dispatchParams: action,
    isCurrent,
    reason: () => reason,
    onDispatchReady: (id: string) => {
      invokeId = id;
    },
    onReady: (chunk: string) => {
      if (!chunk || !invokeId || permitSent) {
        return;
      }
      let ready: ReturnType<typeof InstalledAppLaunchReadySchema.safeParse>;
      try {
        ready = InstalledAppLaunchReadySchema.safeParse(JSON.parse(chunk));
      } catch {
        ready = InstalledAppLaunchReadySchema.safeParse(null);
      }
      const authorized =
        ready.success &&
        ready.data.appId === action.appId &&
        ready.data.appRevision === action.appRevision &&
        params.context.nodeRegistry.isInvokeCurrent(invokeId, params.nodeId, params.connId) &&
        isCurrent();
      permitSent = true;
      params.context.nodeRegistry.sendInvokeInput(
        invokeId,
        authorized
          ? { type: "installed-app-launch.allow", validForMs: 5000 }
          : { type: "installed-app-launch.deny" },
      );
    },
  };
}
