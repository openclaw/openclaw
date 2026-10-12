import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { captureExecRequestSubagentSelection } from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  sessionId?: string;
  execCancellation?: ReturnType<typeof captureExecRequestCancellation>;
  sessionOrigin?: SubagentRequestSessionOrigin;
  assertCurrent?: () => void;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}) {
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentSessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const commands =
    params.execCancellation ??
    captureExecRequestCancellation({
      runId: params.requesterTurnRunId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  const requestSelection = captureExecRequestSubagentSelection({
    ...params,
    controller,
    owners: commands.owners,
  });
  let execAborted = false;
  const commandErrors: unknown[] = [];
  const beforeKill = async (sealRootSelection = () => {}) => {
    // Gateway callbacks signal their captured parent before awaiting its cleanup.
    sealRootSelection();
    if ((await params.beforeKill?.(sealRootSelection)) === false) {
      return false;
    }
    try {
      params.assertCurrent?.();
    } catch (error) {
      // Without descendants, the caller owns the original authority exception.
      if (requestSelection.runs.length === 0) {
        throw error;
      }
      commandErrors.push(error);
      return false;
    }
    execAborted = commands.cancel();
    return true;
  };
  let descendants: Awaited<ReturnType<typeof killAllControlledSubagentRuns>> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    if (requestSelection.runs.length === 0) {
      await beforeKill();
    } else {
      descendants = await killAllControlledSubagentRuns({
        cfg: params.cfg,
        controller,
        runs: requestSelection.runs,
        requestSelection,
        suppressTaskDelivery: true,
        assertCurrent: params.assertCurrent,
        beforeKill,
      });
    }
  } catch (error) {
    failure = { error };
  }
  try {
    // The parent may already have accepted Stop before the caller was revoked.
    await commands.settle();
  } catch (error) {
    commandErrors.push(error);
  }
  if (failure) {
    throw commandErrors.length > 0
      ? new AggregateError([failure.error, ...commandErrors], "Request cancellation was incomplete")
      : failure.error;
  }
  if (commandErrors.length > 0) {
    return {
      ...(descendants ?? { killed: 0, labels: [] }),
      status: "error" as const,
      error: [
        ...(descendants && descendants.status !== "ok" ? [descendants.error] : []),
        ...commandErrors.map(formatErrorMessage),
      ].join("; "),
      execAborted: execAborted || descendants?.execAborted === true,
    };
  }
  return descendants || execAborted
    ? {
        ...(descendants ?? { status: "ok" as const, killed: 0, labels: [] }),
        execAborted: execAborted || descendants?.execAborted === true,
      }
    : undefined;
}

export function descendantAbortError(
  result: Awaited<ReturnType<typeof abortControlledSubagents>>,
  subject: "Parent run" | "Session",
) {
  return result && result.status !== "ok"
    ? errorShape(
        ErrorCodes.UNAVAILABLE,
        `${subject} stopped, but descendant cancellation was incomplete: ${result.error}`,
      )
    : undefined;
}
