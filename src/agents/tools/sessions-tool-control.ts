import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  jsonResult,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import {
  getInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { prepareSessionControlTarget } from "./sessions-control-authority.js";
import { captureSessionControlAuthority } from "./sessions-operator-authority.js";

type ControlTarget = {
  cfg: OpenClawConfig;
  agentId: string;
  key: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string | null;
  operation: "archive" | "restore" | "stop";
  restricted: boolean;
};

export async function prepareSessionToolControlTarget(target: ControlTarget) {
  const { key, restricted, ...identity } = target;
  const source = restricted ? captureSessionControlAuthority() : undefined;
  if (restricted && !source?.allows("operator.write")) {
    throw new ToolAuthorizationError("Session control requires a current operator write grant");
  }
  return await prepareSessionControlTarget({
    ...identity,
    sessionKey: key,
    authority: source?.authority,
  });
}

/** The existing Gateway writer owns the effect; this additional target condition reaches its commit. */
export async function callSessionToolControl<T>(
  target: ControlTarget,
  request: Parameters<AgentToolGatewayRequestCaller>[0],
  callGateway: AgentToolGatewayRequestCaller,
): Promise<T> {
  const control = await prepareSessionToolControlTarget(target);
  try {
    return await callGateway<T>({
      ...request,
      sessionMutationCommitGuard: composeSessionSourceAssertion([
        captureExternalSessionCommitGuard(request.sessionMutationCommitGuard),
        control.assertCurrent,
      ]),
    });
  } finally {
    control.release();
  }
}

export function captureSessionStopCaller() {
  const caller = getGatewayToolCallerIdentity();
  const assertCurrent = captureGatewayToolCallerAssertion();
  if (!caller || !assertCurrent || !getInProcessGatewayToolContext()) {
    throw new ToolAuthorizationError(
      "Session stop requires its admitted in-process Gateway caller",
    );
  }
  assertCurrent();
  return { agentId: caller.agentId, sessionKey: caller.sessionKey, assertCurrent };
}

export async function stopSessionTool(
  target: ControlTarget & { isRequesterSession: boolean },
  params: Record<string, unknown>,
  callGateway: AgentToolGatewayRequestCaller,
  agentToolCaller: ReturnType<typeof captureSessionStopCaller>,
  signal?: AbortSignal,
) {
  if (target.isRequesterSession) {
    throw new ToolInputError(
      "To stop the calling session, finish the current reply; use stop for another session.",
    );
  }
  if (params.clearQueued !== undefined && typeof params.clearQueued !== "boolean") {
    throw new ToolInputError("clearQueued must be boolean");
  }
  const runId =
    params.runId !== undefined
      ? readToolStringParam(params, "runId", { required: true })
      : undefined;
  if (runId && params.clearQueued === true) {
    throw new ToolInputError("Exact-run stop cannot clear unrelated queued followups");
  }
  agentToolCaller.assertCurrent();
  return jsonResult(
    await callSessionToolControl(
      target,
      {
        method: "sessions.abort",
        agentToolCaller,
        signal,
        params: {
          key: target.key,
          ...(parseAgentSessionKey(target.key) ? {} : { agentId: target.agentId }),
          ...(runId ? { runId } : { clearQueued: params.clearQueued ?? true }),
        },
      },
      callGateway,
    ),
  );
}
