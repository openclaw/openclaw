import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import {
  withDelegatedUpdateCommandExecutor,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import type { UpdateRepairTurnMessage, UpdateRepairTurnResult } from "./update-repair-protocol.js";
import { repairSummary, runLocalUpdateRepairTurn } from "./update-repair-turn.js";
import {
  createManagedUpdateRequesterAuthority,
  createManagedUpdateRequesterContinuationAuthority,
  resolveManagedUpdateRequester,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { getUpdateRun } from "./update-run-ledger.js";

const log = createSubsystemLogger("update/repair");

export async function runDelegatedUpdateRepairTurn(
  message: UpdateRepairTurnMessage,
  admissionEnv: NodeJS.ProcessEnv,
  parentSignal: AbortSignal,
  onRoute: (route: { model: string; provider: string }) => void,
): Promise<UpdateRepairTurnResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const deadline = Date.now() + message.wallClockMs;
  const wallTimer = setTimeout(
    () => controller.abort(new Error("wall-clock-budget")),
    message.wallClockMs,
  );
  const traceTimings = log.isEnabled("trace");
  const timings = { checks: 0, fenceMs: 0, requesterMs: 0, runMs: 0, totalMs: 0 };
  const measure = <T>(phase: "fenceMs" | "requesterMs" | "runMs", operation: () => T): T => {
    if (!traceTimings) {
      return operation();
    }
    const started = performance.now();
    try {
      return operation();
    } finally {
      timings[phase] += performance.now() - started;
    }
  };
  try {
    return await withDelegatedUpdateCommandExecutor(
      // SAFETY: The canonical owner validates this private IPC grant against live rows and our PID/start identity.
      message.executor as UpdateCommandChildGrant,
      message.runId,
      message.target.installRoot,
      async (fence) => {
        fence.assertCurrent();
        const readCurrentRun = () => {
          const run = measure("runMs", () => getUpdateRun(message.runId, { env: admissionEnv }));
          if (!process.connected || run?.status !== "running" || run.phase !== "repairing") {
            throw new Error("Repair no longer owns the update attempt.");
          }
          if (!isDeepStrictEqual(run.origin.requester, message.requester)) {
            throw new UpdateRequesterRevokedError();
          }
          return run;
        };
        const requesterInput = resolveManagedUpdateRequester(readCurrentRun().origin.requester);
        const runtime = await import("./update-repair-agent.runtime.js");
        fence.assertCurrent();
        const requester = requesterInput
          ? await runtime.withUpdateRepairEnvironment(message.target, () =>
              requesterInput.authorizationSource?.startsWith("profile:")
                ? createManagedUpdateRequesterContinuationAuthority(
                    requesterInput,
                    { runId: message.runId, executor: fence },
                    admissionEnv,
                  )
                : createManagedUpdateRequesterAuthority(requesterInput, admissionEnv),
            )
          : undefined;
        const assertAuthority = () => {
          const started = traceTimings ? performance.now() : 0;
          timings.checks += 1;
          try {
            measure("fenceMs", () => fence.assertCurrent());
            return withSynchronousArtifactPreservingStateSnapshot(
              () => {
                readCurrentRun();
                if (measure("requesterMs", () => requester?.isCurrent()) === false) {
                  throw new UpdateRequesterRevokedError();
                }
                return true;
              },
              { current: { env: admissionEnv } },
            );
          } finally {
            if (traceTimings) {
              timings.totalMs += performance.now() - started;
            }
          }
        };
        const assertCurrent = () => {
          signal.throwIfAborted();
          return assertAuthority();
        };
        assertCurrent();
        const selected = await runtime.withUpdateRepairEnvironment(message.target, () =>
          runtime.prepareUpdateRepairInference(signal, Math.max(1, deadline - Date.now())),
        );
        assertCurrent();
        if (!selected.ok) {
          return { status: "unavailable", reason: repairSummary(selected.reason, message.target) };
        }
        const { route, modelFallbacks } = selected;
        onRoute({ model: route.model, provider: route.provider });
        // Route preparation uses the total budget; inference gets its own turn budget afterward.
        const timeoutMs = Math.min(message.timeoutMs, deadline - Date.now());
        if (timeoutMs <= 0) {
          throw new Error("wall-clock-budget");
        }
        const turnTimer = setTimeout(
          () => controller.abort(new Error("per-turn-budget")),
          timeoutMs,
        );
        const cleanup = createAgentCleanupScope();
        try {
          const result = await cleanup.run(() =>
            runLocalUpdateRepairTurn({
              target: message.target,
              route,
              modelFallbacks,
              prompt: message.prompt,
              timeoutMs,
              maxToolCalls: message.maxToolCalls,
              signal,
              isCurrent: assertCurrent,
            }),
          );
          // Parent cancellation revokes the whole delegated request. A local
          // deadline may still return the bounded turn result as timed out.
          parentSignal.throwIfAborted();
          assertAuthority();
          if (cleanup.outcome === "uncertain") {
            throw new Error("Update repair cleanup could not be confirmed.");
          }
          return result.status === "completed"
            ? { ...result, timedOut: result.timedOut || controller.signal.aborted }
            : result;
        } finally {
          clearTimeout(turnTimer);
        }
      },
    );
  } catch (error) {
    return {
      status: "aborted",
      reason: repairSummary(error instanceof Error ? error.message : String(error), message.target),
    };
  } finally {
    clearTimeout(wallTimer);
    if (traceTimings) {
      log.trace(`authority check timing ${JSON.stringify(timings)}`);
    }
  }
}
