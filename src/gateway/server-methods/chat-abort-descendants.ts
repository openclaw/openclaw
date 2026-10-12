import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { withAgentHarnessDescendantCancellation } from "../../agents/harness/descendant-cancellation.js";
import type { AgentHarnessDescendantCancellationResult } from "../../agents/harness/types.js";
import { captureExecRequestSubagentSelection } from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureExecRequestCustodySelection } from "../../infra/exec-request-context.js";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  sessionId?: string;
  lifecycleRevision?: string;
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
  let stopEntered = false;
  const acceptsRequest = captureExecRequestCustodySelection(
    commands.owners,
    params.requesterTurnRunId === undefined ? params.sessionOrigin : undefined,
  );
  const stop = async (cancelNative: () => Promise<AgentHarnessDescendantCancellationResult>) => {
    stopEntered = true;
    let native: Promise<PromiseSettledResult<AgentHarnessDescendantCancellationResult>> | undefined;
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
      // An accepted Stop must join native work even if the legacy cascade fails.
      native = Promise.allSettled([cancelNative()]).then(([result]) => result);
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
    const settledNative = await native;
    if (settledNative?.status === "fulfilled") {
      commandErrors.push(...(settledNative.value.errors ?? []));
    }
    if (settledNative?.status === "rejected") {
      commandErrors.push(settledNative.reason);
    }
    const killed =
      (descendants?.killed ?? 0) +
      (settledNative?.status === "fulfilled" ? settledNative.value.killed : 0);
    const cancelledRequesters =
      settledNative?.status === "fulfilled" ? settledNative.value.cancelledRequesters : [];
    if (failure && !settledNative && !descendants && !execAborted) {
      throw commandErrors.length > 0
        ? new AggregateError(
            [failure.error, ...commandErrors],
            "Request cancellation was incomplete",
          )
        : failure.error;
    }
    if (failure) {
      commandErrors.push(failure.error);
    }
    if (commandErrors.length > 0) {
      return {
        ...(descendants ?? { killed: 0, labels: [] }),
        killed,
        cancelledRequesters,
        status: "error" as const,
        error: [
          ...(descendants && descendants.status !== "ok" ? [descendants.error] : []),
          ...commandErrors.map(formatErrorMessage),
        ].join("; "),
        execAborted: execAborted || descendants?.execAborted === true,
      };
    }
    return descendants || execAborted || killed
      ? {
          ...(descendants ?? { status: "ok" as const, killed: 0, labels: [] }),
          killed,
          cancelledRequesters,
          execAborted: execAborted || descendants?.execAborted === true,
        }
      : undefined;
  };
  if (!params.sessionId) {
    return stop(async () => ({ killed: 0, cancelledRequesters: [] }));
  }
  let completed: Awaited<ReturnType<typeof stop>>;
  try {
    return await withAgentHarnessDescendantCancellation(
      {
        agentId: controller.controllerAgentId,
        sessionKey: controller.controllerSessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        requesterTurnRunId: params.requesterTurnRunId,
        acceptsRequest,
        assertCurrent: () => params.assertCurrent?.(),
      },
      async (cancel) => {
        completed = await stop(cancel);
        return completed;
      },
    );
  } catch (error) {
    if (stopEntered) {
      if (!completed) {
        throw error;
      }
      // Keep settled cancellations when the harness loses authority after its callback.
      return {
        ...completed,
        status: "error" as const,
        error: [
          completed.status === "error" ? completed.error : undefined,
          formatErrorMessage(error),
        ]
          .filter(Boolean)
          .join("; "),
      };
    }
    // A stale native reservation must not strand an independently captured parent.
    // Stop that parent once, but report its descendants as unconfirmed.
    params.assertCurrent?.();
    return stop(async () => {
      throw error;
    });
  }
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
