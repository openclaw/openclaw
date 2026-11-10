import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-dispatch.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { settlesWithin } from "../../shared/settle-within.js";
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
  signal?.throwIfAborted();
  const gateway = getInProcessGatewayToolContext();
  const custody = await captureOperatorToolGatewayContinuationContext({
    agentId: target.agentId,
    sessionKey: target.key,
  });
  if (!custody) {
    throw new ToolAuthorizationError("Session stop requires its admitted Gateway custody");
  }
  let control: Awaited<ReturnType<typeof prepareSessionToolControlTarget>> | undefined;
  let execution: Promise<unknown> | undefined;
  let settling = false;
  try {
    control = await custody.run(() => prepareSessionToolControlTarget(target));
    agentToolCaller.assertCurrent();
    signal?.throwIfAborted();
    const selected = control;
    // Accepted Stop belongs to the Gateway, not the calling turn's reply deadline.
    execution = custody.run(() =>
      callGateway({
        method: "sessions.abort",
        agentToolCaller: { ...agentToolCaller, assertCurrent: custody.assertCurrent },
        signal: custody.signal,
        timeoutMs: null,
        sessionMutationCommitGuard: selected.assertCurrent,
        params: {
          key: target.key,
          ...(parseAgentSessionKey(target.key) ? {} : { agentId: target.agentId }),
          ...(runId ? { runId } : { clearQueued: params.clearQueued ?? true }),
        },
      }),
    );
    if (await settlesWithin(execution, 5_000)) {
      return jsonResult(await execution);
    }
    settling = true;
    return jsonResult({
      ok: true,
      abortedRunId: null,
      status: "settling",
      warning: "Stop was accepted and is still settling. Check the session status before retrying.",
    });
  } finally {
    const release = () => {
      control?.release();
      custody.release();
    };
    if (execution) {
      void execution.then(release, (error: unknown) => {
        try {
          if (settling) {
            gateway?.logGateway.warn(`Deferred session Stop failed: ${formatErrorMessage(error)}`);
          }
        } finally {
          release();
        }
      });
    } else {
      release();
    }
  }
}
