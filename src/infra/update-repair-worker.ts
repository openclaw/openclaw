import { spawn } from "node:child_process";
import path from "node:path";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor.js";
import { createCommandTerminationController } from "../process/exec-termination.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairBudgetSchema,
  updateRepairParentMessageSchema,
  updateRepairWorkerMessageSchema,
  type UpdateRepairParentMessage,
  type UpdateRepairParams,
  type UpdateRepairTurnParams,
  type UpdateRepairTurnResult,
} from "./update-repair-protocol.js";
import { repairSummary } from "./update-repair-turn.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

/** The child owns inference; the parent regains effects only after the child tree exits. */
export async function runUpdateRepairWorker(
  params: UpdateRepairParams & { executorFence: UpdateRecoveryFence; runId: string },
  turn: UpdateRepairTurnParams,
): Promise<UpdateRepairTurnResult> {
  return await withUpdateCommandExecutorChild(
    params.executorFence,
    params.target.installRoot,
    (grant, bindChild) => runWorker(params, turn, { grant, bindChild }),
  );
}

async function runWorker(
  params: UpdateRepairParams,
  turn: UpdateRepairTurnParams,
  delegation: { grant: UpdateCommandChildGrant; bindChild: (pid: number) => void },
): Promise<UpdateRepairTurnResult> {
  const clean = (value: unknown) =>
    repairSummary(value instanceof Error ? value.message : String(value), params.target);
  const assertCurrent = () => {
    // The parent executor is suspended here. The delegated child checks both live
    // lease owners at each tool effect; these parent reads check requester/run admission.
    if (params.isCurrent?.() === false) {
      throw new Error("Repair no longer owns the update attempt.");
    }
  };
  turn.signal.throwIfAborted();
  assertCurrent();
  const env = {
    ...(params.admissionEnv ?? {
      ...process.env,
      ...installationTargetEnv({
        stateDir: params.target.stateDir,
        configPath: params.target.configPath,
        defaultWorkspaceDir: params.target.workspaceDir,
      }),
    }),
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  const { installRoot } = params.target;
  const child = spawn(
    params.nodeRunner ?? process.execPath,
    [path.join(installRoot, "dist", runtimeProcessEntrypoints.updateRepair.distWorkerPath)],
    {
      cwd: installRoot,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let childExited = false;
  let commandSettled = false;
  let bound = false;
  let started = false;
  let routeSelected = false;
  let result: UpdateRepairTurnResult | undefined;
  let failure: string | undefined;
  let stopping = false;
  const cancelController = new AbortController();
  const termination = createCommandTerminationController({
    child,
    cancelController,
    env,
    processTree: { mode: "graceful" },
    killGraceMs: 1_000,
    isChildExited: () => childExited,
    isCommandSettled: () => commandSettled,
  });
  cancelController.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  const stop = (error: unknown) => {
    if (stopping) {
      return;
    }
    stopping = true;
    failure ??= clean(error);
    if (!termination.terminate()) {
      cancelController.abort();
    }
  };
  const send = (message: UpdateRepairParentMessage) => {
    if (!child.connected) {
      return stop(new Error("Update repair worker closed its control channel."));
    }
    if (Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      return stop(new Error("Update repair message exceeded its diagnostic limit."));
    }
    child.send(message, (error) => {
      if (error) {
        stop(error);
      }
    });
  };
  const onAbort = () => {
    if (child.connected) {
      send({ type: "cancel", reason: clean(turn.signal.reason) });
    }
    stop(turn.signal.reason);
  };
  turn.signal.addEventListener("abort", onAbort, { once: true });
  if (turn.signal.aborted) {
    onAbort();
  }
  child.once("spawn", () => {
    try {
      if (!child.pid) {
        throw new Error("Update repair worker has no process identity.");
      }
      delegation.bindChild(child.pid);
      bound = true;
    } catch (error) {
      stop(error);
    }
  });
  child.on("message", (raw: unknown) => {
    // A cooperative cancellation may still return the drained turn's tool count.
    if (stopping && !turn.signal.aborted) {
      return;
    }
    try {
      assertCurrent();
      if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
        throw new Error("Update repair response exceeded its diagnostic limit.");
      }
      const message = updateRepairWorkerMessageSchema.parse(raw);
      if (message.type === "ready") {
        if (started || !bound) {
          throw new Error("Update repair worker startup does not own its process.");
        }
        // Older shipped workers cannot honor executor grants or yield custody
        // before the parent oracle. Refuse before sending them executable input.
        if (!message.repairTurns || message.executorDelegation !== "pid-start-v1") {
          throw new Error(
            "This version cannot safely run automatic update repair. Run openclaw triage to inspect the failure.",
          );
        }
        if (turn.signal.aborted) {
          return;
        }
        started = true;
        const { phase, beforeVersion, targetVersion, symptoms, ...failureContext } = params.context;
        send(
          updateRepairParentMessageSchema.parse({
            type: "start",
            runId: params.runId,
            requester: params.requester,
            executor: delegation.grant,
            target: params.target,
            failure: failureContext,
            context: { phase, beforeVersion, targetVersion, symptoms },
            budget: updateRepairBudgetSchema.parse(params.budget ?? {}),
            turn: {
              prompt: turn.prompt,
              timeoutMs: turn.timeoutMs,
              maxToolCalls: turn.maxToolCalls,
            },
          }),
        );
      } else if (message.type === "event" && message.event.type === "route-selected") {
        if (!started || routeSelected || result) {
          throw new Error("Update repair repeated its inference admission.");
        }
        routeSelected = true;
        turn.onRoute({ model: message.event.model, provider: message.event.provider });
      } else if (message.type === "turn-result") {
        if (
          !started ||
          result ||
          (message.result.status === "completed" &&
            (!routeSelected || message.result.toolCalls > turn.maxToolCalls))
        ) {
          throw new Error("Update repair returned an invalid turn result.");
        }
        result = message.result;
      } else {
        throw new Error("Update repair worker sent a message outside its inference turn.");
      }
    } catch (error) {
      stop(error);
    }
  });
  child.once("disconnect", () => {
    if (!result) {
      stop(new Error("Update repair worker closed its control channel."));
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      failure ??= clean(error);
    });
    child.once("exit", () => {
      childExited = true;
    });
    child.once("close", (code) => {
      commandSettled = true;
      resolve(code);
    });
  });
  try {
    const code = await closed;
    // A normal root exit is not proof that its descendants have stopped.
    termination.terminate();
    await termination.settle();
    // The executor owner checks PID exit and, on POSIX, process-group absence
    // before releasing custody. A signal result cannot authorize that release.
    try {
      assertCurrent();
    } catch (error) {
      // Requester/run cancellation is a turn outcome. The executor owner still
      // must verify and release custody; failures there remain fatal.
      return { status: "aborted", reason: clean(error) };
    }
    if (result && code === 0 && (!failure || turn.signal.aborted)) {
      return result;
    }
    return {
      status: routeSelected ? "aborted" : "unavailable",
      reason:
        failure ??
        "Update repair worker exited without a result. Run openclaw triage to inspect the installation.",
    };
  } finally {
    turn.signal.removeEventListener("abort", onAbort);
  }
}
