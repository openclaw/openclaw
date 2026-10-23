import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  getRpcSource,
  isRpcSourceExecuting,
} from "../../../sessions/session-controller.rpc-sources.js";
import type { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { getPreparedModelRuntimeMocks } from "../../prepared-model-runtime.test-harness.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { resolveSubagentSessionStatus } from "../registry/subagent-session-metrics.js";

/** Reads bounded lifecycle facts without exposing model input or workspace paths. */
export function readBoundExecutionState(
  bound: {
    context: Pick<ReturnType<typeof createChatAbortContext>, "dedupe" | "logGateway">;
    execution: Pick<AsyncWorkScope, "hasPendingWork">;
  },
  childRunId?: string,
) {
  const context = bound.context as unknown as GatewayRequestContext;
  const receipt = childRunId ? context.dedupe.get(`agent:${childRunId}`) : undefined;
  const payload = asOptionalRecord(receipt?.payload);
  const cause = asOptionalRecord(asOptionalRecord(receipt?.error)?.cause);
  const controller = childRunId ? getRpcSource(childRunId) : undefined;
  const execution = childRunId ? subagentRuns.get(childRunId)?.execution : undefined;
  const collector = childRunId ? subagentRuns.get(childRunId) : undefined;
  const label = (value: unknown, allowed: readonly string[]) =>
    typeof value === "string" && allowed.includes(value) ? value : "unknown";
  // Read bounded lifecycle facts before finally settles the synthetic model run.
  return {
    executionPending: bound.execution.hasPendingWork,
    receiptPresent: receipt !== undefined,
    receiptOk: receipt?.ok,
    receiptStatus: label(payload?.status, ["accepted", "in_flight", "ok", "error", "timeout"]),
    receiptErrorCode: label(receipt?.error?.code, ["UNAVAILABLE", "INVALID_REQUEST", "FORBIDDEN"]),
    causeName: label(cause?.name, [
      "Error",
      "TypeError",
      "AbortError",
      "TimeoutError",
      "SqliteWorkerError",
      "FailoverError",
    ]),
    controllerPresent: controller !== undefined,
    controllerAborted: controller?.input.abortSignal.aborted,
    executionStarted: isRpcSourceExecuting(controller),
    executionStatus: label(execution?.status, ["queued", "running", "interrupted", "terminal"]),
    runStatus: label(
      childRunId ? resolveSubagentSessionStatus(subagentRuns.get(childRunId)) : undefined,
      ["queued", "running", "done", "failed", "killed", "timeout"],
    ),
    queuedLaunchPresent: collector?.queuedLaunch !== undefined,
    collectorCleanupPending: collector?.collectorLaunchCleanupPending === true,
    collectorKillPending: collector?.killIntent !== undefined,
    outcomeStatus: label(execution?.outcome?.status, ["ok", "error", "timeout"]),
    gatewayWarningCount: vi.mocked(context.logGateway.warn).mock.calls.length,
    runtimeWarningCount: getPreparedModelRuntimeMocks().warn.mock.calls.length,
  };
}
