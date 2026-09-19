import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import {
  withDelegatedUpdateCommandExecutor,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor.js";
import type { UpdateRepairTurnMessage, UpdateRepairTurnResult } from "./update-repair-protocol.js";
import { repairSummary, runLocalUpdateRepairTurn } from "./update-repair-turn.js";
import {
  createManagedUpdateRequesterAuthority,
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
  const deadline = Date.now() + message.wallClockMs;
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
        const runtime = await import("./update-repair-agent.runtime.js");
        fence.assertCurrent();
        const requesterInput = message.requester;
        const requester = requesterInput
          ? await runtime.withUpdateRepairEnvironment(message.target, () =>
              createManagedUpdateRequesterAuthority(requesterInput, admissionEnv),
            )
          : undefined;
        const assertCurrent = () => {
          signal.throwIfAborted();
          fence.assertCurrent();
          if (requester?.isCurrent() === false) {
            throw new UpdateRequesterRevokedError();
          }
          const run = getUpdateRun(message.runId, { env: admissionEnv });
          if (!process.connected || run?.status !== "running" || run.phase !== "repairing") {
            throw new Error("Repair no longer owns the update attempt.");
          }
          return true;
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
          if (!signal.aborted) {
            assertCurrent();
          }
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
