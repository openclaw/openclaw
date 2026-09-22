import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  type UpdateRepairWorkerMessage,
} from "./update-repair-protocol.js";

// Released updaters invoke this entry before their update has settled. Keep the
// wire contract, but leave inference and operator state to post-failure triage.
const deferredReason =
  "Inference repair is deferred until after the update has failed. Updates do not require inference.";
let finished = false;

function send(message: UpdateRepairWorkerMessage, complete?: () => void): void {
  if (
    !process.connected ||
    !process.send ||
    Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES
  ) {
    process.exit(1);
  }
  process.send(message, (error) => {
    if (error) {
      process.exit(1);
    }
    complete?.();
  });
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

process.once("disconnect", () => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => finish("aborted", "Repair worker cancelled."));
}
process.on("message", (raw: unknown) => {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      throw new Error("Repair request exceeded its bounded diagnostic budget.");
    }
    const message = updateRepairParentMessageSchema.parse(raw);
    if (message.type === "cancel") {
      finish("aborted", message.reason);
    } else if (message.type === "start") {
      finish("unavailable", deferredReason);
    } else {
      throw new Error("Repair worker did not request validation.");
    }
  } catch {
    process.exit(1);
  }
});
send({ type: "ready", candidateRehearsal: true });
