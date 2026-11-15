import { isDeepStrictEqual } from "node:util";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import {
  withDelegatedUpdateCommandExecutor,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor.js";
import { monotonicDeadlineAfter, remainingMonotonicMs } from "../shared/monotonic-time.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import type { UpdateRepairTurnMessage, UpdateRepairTurnResult } from "./update-repair-protocol.js";
import { repairSummary, runLocalUpdateRepairTurn } from "./update-repair-turn.js";
import {
  createDelegatedUpdateRequesterAuthority,
  resolveManagedUpdateRequester,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { getUpdateRun } from "./update-run-ledger.js";

export async function runDelegatedUpdateRepairTurn(
  message: UpdateRepairTurnMessage,
  admissionEnv: NodeJS.ProcessEnv,
  parentSignal: AbortSignal,
  onRoute: (route: { model: string; provider: string }) => void,
): Promise<UpdateRepairTurnResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  const deadline = monotonicDeadlineAfter(message.wallClockMs);
  const wallTimer = setTimeout(
    () => controller.abort(new Error("wall-clock-budget")),
    message.wallClockMs,
  );
  try {
    return await withDelegatedUpdateCommandExecutor(
      // SAFETY: The canonical owner validates this private IPC grant against live rows and our PID/start identity.
      message.executor as UpdateCommandChildGrant,
      message.runId,
      message.target.installRoot,
      async (fence) => {
        fence.assertCurrent();
        const readCurrentRun = () => {
          const run = getUpdateRun(message.runId, { env: admissionEnv });
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
              createDelegatedUpdateRequesterAuthority(
                requesterInput,
                message.runId,
                fence,
                admissionEnv,
              ),
            )
          : undefined;
        const assertAuthority = () => {
          fence.assertCurrent();
          return withSynchronousArtifactPreservingStateSnapshot(
            () => {
              readCurrentRun();
              if (requester?.isCurrent() === false) {
                throw new UpdateRequesterRevokedError();
              }
              return true;
            },
            { current: { env: admissionEnv } },
          );
        };
        const assertCurrent = () => {
          signal.throwIfAborted();
          return assertAuthority();
        };
        // The embedded run re-checks its source at every preparation stage; copying
        // the shared database for each one made those checks the turn's critical
        // path. Preparation carries the run row and requester policy observed before
        // the turn and keeps executor ownership, the parent connection, and
        // cancellation live. Model candidates, tool admission, tool effect guards,
        // and settlement still observe the run row and requester policy fresh.
        const assertTurnLive = () => {
          signal.throwIfAborted();
          if (!process.connected) {
            throw new Error("Repair no longer owns the update attempt.");
          }
          fence.assertCurrent();
          return true;
        };
        assertCurrent();
        const selected = await runtime.withUpdateRepairEnvironment(message.target, () =>
          runtime.prepareUpdateRepairInference(signal, Math.max(1, remainingMonotonicMs(deadline))),
        );
        assertCurrent();
        if (!selected.ok) {
          return { status: "unavailable", reason: repairSummary(selected.reason, message.target) };
        }
        const { route, modelFallbacks } = selected;
        onRoute({ model: route.model, provider: route.provider });
        // Route preparation uses the total budget; inference gets its own turn budget afterward.
        // Preserve whole-millisecond expiration at the turn boundary.
        const timeoutMs = Math.min(message.timeoutMs, Math.floor(remainingMonotonicMs(deadline)));
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
              isLive: assertTurnLive,
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
  }
}
