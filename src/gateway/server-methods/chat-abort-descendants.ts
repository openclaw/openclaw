import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { withAgentHarnessDescendantCancellation } from "../../agents/harness/descendant-cancellation.js";
import type { AgentHarnessDescendantCancellationResult } from "../../agents/harness/types.js";
import {
  captureExecRequestSubagentSelection,
  resolveSubagentControllerIdentity,
} from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import { isSameSubagentRunOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import { prepareSessionCapabilityRead } from "../../agents/subagents/spawn/subagent-session-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureExecRequestCustodySelection } from "../../infra/exec-request-context.js";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  yieldedRequesterRunId?: string;
  sessionId?: string;
  lifecycleRevision?: string;
  execCancellation?: ReturnType<typeof captureExecRequestCancellation>;
  sessionOrigin?: SubagentRequestSessionOrigin;
  assertCurrent?: () => void;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
  /** Accepted parent effects retain cleanup reporting after a later guard rejects. */
  parentStopAccepted?: () => boolean;
  prepareSelection?: {
    acceptsRequest: SubagentRequestSessionOrigin["acceptsRequest"];
    prepare: () => Promise<{
      execCancellation: ReturnType<typeof captureExecRequestCancellation>;
      sessionOrigin?: SubagentRequestSessionOrigin;
    }>;
  };
}) {
  const controllerParams = {
    cfg: params.cfg,
    agentSessionKey: params.sessionKey,
    agentId: params.agentId,
  };
  const identity = resolveSubagentControllerIdentity(controllerParams);
  // Ordinary callers reserve queued descendants before yielding; only subagents need policy reads.
  const preparedController = identity.callerIsSubagent
    ? await prepareSessionCapabilityRead(() => resolveSubagentController(controllerParams))
    : undefined;
  using controllerRead = preparedController
    ? { [Symbol.dispose]: preparedController.release }
    : undefined;
  void controllerRead;
  const controller = preparedController?.read() ?? {
    ...identity,
    controlScope: "children" as const,
  };
  const assertCurrent = () => {
    params.assertCurrent?.();
    preparedController?.read();
  };
  let commands =
    params.execCancellation ??
    captureExecRequestCancellation({
      runId: params.requesterTurnRunId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  let selected = captureExecRequestSubagentSelection({
    ...params,
    controller,
    owners: commands.owners,
    candidateOrigin: params.prepareSelection
      ? {
          target: {
            sessionKey: controller.controllerSessionKey,
            agentId: controller.controllerAgentId,
          },
          acceptsRequest: params.prepareSelection.acceptsRequest,
        }
      : undefined,
  });
  let sessionOrigin = params.sessionOrigin;
  const preparation = params.prepareSelection;
  const prepare = preparation
    ? async () => {
        const prepared = await preparation.prepare();
        commands = prepared.execCancellation;
        sessionOrigin = prepared.sessionOrigin;
        selected = captureExecRequestSubagentSelection({
          ...params,
          controller,
          owners: commands.owners,
          sessionOrigin: prepared.sessionOrigin,
        });
      }
    : undefined;
  const requestSelection = {
    runs: selected.runs,
    ownsRoot: (entry: (typeof selected.runs)[number]) => selected.ownsRoot(entry),
    selectPublishedRoot:
      preparation || selected.selectPublishedRoot
        ? (entry: (typeof selected.runs)[number]) => selected.selectPublishedRoot?.(entry) === true
        : undefined,
    get sessionGeneration() {
      return selected.sessionGeneration;
    },
    prepare,
  };
  let execAborted = false;
  const registryCancelledRequesters: AgentHarnessDescendantCancellationResult["cancelledRequesters"] =
    [];
  let yieldedRequesters: Array<{
    entry: (typeof selected.runs)[number];
    requester: AgentHarnessDescendantCancellationResult["cancelledRequesters"][number];
  }> = [];
  let native: Promise<PromiseSettledResult<AgentHarnessDescendantCancellationResult>> | undefined;
  const commandErrors: unknown[] = [];
  const beforeKill = async (sealRootSelection = () => {}) => {
    // Keep both cancellation owners inside the existing legacy dispatch reservation.
    sealRootSelection();
    let entered = false;
    let accepted = false;
    const stop = async (cancelNative: () => Promise<AgentHarnessDescendantCancellationResult>) => {
      entered = true;
      if ((await params.beforeKill?.(sealRootSelection)) === false) {
        return false;
      }
      try {
        assertCurrent();
      } catch (error) {
        if (requestSelection.runs.length === 0) {
          throw error;
        }
        commandErrors.push(error);
        return false;
      }
      accepted = true;
      const sessionId = params.sessionId ?? sessionOrigin?.target.sessionId;
      yieldedRequesters = sessionId
        ? requestSelection.runs.flatMap((entry) => {
            // A settled yielded cohort releases its spawning turn links. Stop
            // captures the parent's current lifecycle owner instead of reviving them.
            const requesterTurnRunId =
              params.yieldedRequesterRunId ??
              (entry.requesterTurnYielded ? entry.requesterTurnRunId : undefined);
            return selected.ownsRoot(entry) &&
              entry.requesterSessionKey === controller.controllerSessionKey &&
              (entry.requesterAgentId ?? controller.controllerAgentId) ===
                controller.controllerAgentId &&
              requesterTurnRunId &&
              (entry.execution.status !== "terminal" ||
                entry.pauseReason === "sessions_yield" ||
                entry.requesterSettleWake)
              ? [
                  {
                    entry,
                    requester: {
                      agentId: controller.controllerAgentId,
                      sessionKey: controller.controllerSessionKey,
                      sessionId,
                      lifecycleRevision:
                        params.lifecycleRevision ??
                        sessionOrigin?.target.lifecycleRevision ??
                        undefined,
                      requesterTurnRunId,
                    },
                  },
                ]
              : [];
          })
        : [];
      native = Promise.allSettled([cancelNative()]).then(([result]) => result);
      try {
        execAborted = commands.cancel();
      } finally {
        // Native reservations live until this callback returns; join their cancellation here.
        await native;
      }
      return true;
    };
    const sessionId = params.sessionId ?? sessionOrigin?.target.sessionId;
    if (!sessionId) {
      return stop(async () => ({ killed: 0, cancelledRequesters: [] }));
    }
    try {
      return await withAgentHarnessDescendantCancellation(
        {
          agentId: controller.controllerAgentId,
          sessionKey: controller.controllerSessionKey,
          sessionId,
          lifecycleRevision:
            params.lifecycleRevision ?? sessionOrigin?.target.lifecycleRevision ?? undefined,
          requesterTurnRunId: params.requesterTurnRunId,
          acceptsRequest: captureExecRequestCustodySelection(
            commands.owners,
            params.requesterTurnRunId === undefined ? sessionOrigin : undefined,
          ),
          assertCurrent,
        },
        stop,
      );
    } catch (error) {
      if (entered) {
        if (!accepted) {
          throw error;
        }
        commandErrors.push(error);
        return true;
      }
      // A stale native reservation must not strand an independently captured parent.
      assertCurrent();
      return stop(async () => {
        throw error;
      });
    }
  };
  let descendants: Awaited<ReturnType<typeof killAllControlledSubagentRuns>> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    if (requestSelection.runs.length === 0 && !prepare) {
      await beforeKill();
    } else {
      descendants = await killAllControlledSubagentRuns({
        cfg: params.cfg,
        controller,
        runs: requestSelection.runs,
        requestSelection,
        suppressTaskDelivery: true,
        onCancelled: (entry) => {
          const captured = yieldedRequesters.find((item) =>
            isSameSubagentRunOwner(entry, item.entry),
          );
          if (captured && !registryCancelledRequesters.includes(captured.requester)) {
            registryCancelledRequesters.push(captured.requester);
          }
        },
        assertCurrent,
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
  const cancelledRequesters = [
    ...registryCancelledRequesters,
    ...(settledNative?.status === "fulfilled" ? settledNative.value.cancelledRequesters : []),
  ];
  if (failure && !settledNative && !descendants && !execAborted && !params.parentStopAccepted?.()) {
    throw commandErrors.length > 0
      ? new AggregateError([failure.error, ...commandErrors], "Request cancellation was incomplete")
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
      failed: (descendants?.status === "error" ? descendants.failed : 0) + commandErrors.length,
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
