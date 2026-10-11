import { MessagePort, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "./worker-task-server.js";

const retained = new Uint8Array(4 * 1024 * 1024).fill(7);
serveWorkerTasks((input) => {
  if (
    isRecord(input) &&
    input.gate instanceof SharedArrayBuffer &&
    input.receipt instanceof MessagePort
  ) {
    const gate = new Int32Array(input.gate);
    input.receipt.postMessage("busy", []);
    while (Atomics.load(gate, 0) === 0) {
      // Deliberately block port events while permitting V8's native heap interrupt.
    }
    input.receipt.close();
  }
  return { threadId, checksum: retained[0]! + retained.at(-1)! };
});
