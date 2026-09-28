import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  type UpdateRepairWorkerMessage,
} from "./update-repair-protocol.js";

// Released updaters invoke this entry before their update has settled. Keep the
// wire contract, but leave inference and operator state to post-failure triage.
const deferredReason =
  "Inference repair is deferred until after the update has failed. Updates do not require inference.";
const controller = new AbortController();
// Capture authority admission before a rehearsal target can project different state paths.
const admissionEnv = { ...process.env };
let started = false;
let finished = false;

function handleSendFailure(error: Error): void {
  if (!started || finished) {
    process.exit(1);
  }
  controller.abort(error);
}

function send(message: UpdateRepairWorkerMessage, complete?: () => void): void {
  if (
    !process.connected ||
    !process.send ||
    Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES
  ) {
    handleSendFailure(new Error("Repair orchestrator disconnected."));
    return;
  }
  process.send(message, (error) => {
    if (error) {
      handleSendFailure(error);
      return;
    }
    complete?.();
  });
}

async function finishTurn(
  result: Extract<UpdateRepairWorkerMessage, { type: "turn-result" }>["result"],
) {
  if (finished) {
    return;
  }
  finished = true;
  await closeOpenClawStateDatabaseAsync();
  send({ type: "turn-result", result }, () => process.exit(0));
}

function finish(status: "unavailable" | "aborted", reason: string): void {
  if (finished) {
    return;
  }
  finished = true;
  send({ type: "event", event: { type: "stopped", status, reason } });
  send(
    {
      type: "result",
      result: {
        status,
        attempts: [],
        finalValidation: { ok: false, score: 0, summary: reason },
        reason,
      },
    },
    () => process.exit(0),
  );
}

process.once("disconnect", () => {
  if (!started || finished) {
    process.exit(0);
  }
  controller.abort(new Error("Repair orchestrator disconnected."));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const error = new Error("Repair worker cancelled.");
    controller.abort(error);
    if (!started) {
      finish("aborted", error.message);
    }
  });
}
process.on("message", (raw: unknown) => {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      throw new Error("Repair request exceeded its bounded diagnostic budget.");
    }
    const message = updateRepairParentMessageSchema.parse(raw);
    if (message.type === "cancel") {
      controller.abort(new Error(message.reason));
      if (!started) {
        finish("aborted", message.reason);
      }
      return;
    }
    if (message.type === "validation-result" || message.type === "validation-error") {
      throw new Error("Repair worker did not request validation.");
    }
    if (started) {
      throw new Error("Repair worker already owns an execution.");
    }
    started = true;
    if (message.type === "start") {
      finish("unavailable", deferredReason);
      return;
    }
    void import("./update-repair-turn-worker.js")
      .then(({ runDelegatedUpdateRepairTurn }) =>
        runDelegatedUpdateRepairTurn(message, admissionEnv, controller.signal, (route) =>
          send({ type: "event", event: { type: "route-selected", ...route } }),
        ),
      )
      .then((result) => finishTurn(result))
      .catch(() => process.exit(1));
  } catch {
    process.exit(1);
  }
});
void withCliProcessScope(retainCliProcessJobUntilExit).then(
  () =>
    send({
      type: "ready",
      candidateRehearsal: true,
      repairTurns: true,
      executorDelegation: "pid-start-v1",
    }),
  () => process.exit(1),
);
