import { writeSync } from "node:fs";
import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";

const deadlineNs = workerData?.deadlineNs;
if (!parentPort || typeof deadlineNs !== "bigint") {
  throw new Error("Shutdown watchdog requires its monotonic deadline");
}

const port = parentPort;
let pending = workerData.pending;
let cancelled = false;
const receive = (message) => {
  if (message === "cancel") {
    cancelled = true;
    clearTimeout(timer);
    port.close();
  } else if (typeof message === "string") {
    pending = message;
  }
};
const delayMs = Math.max(0, Number(deadlineNs - process.hrtime.bigint()) / 1_000_000);
const timer = setTimeout(() => {
  // A deadline spent starting this worker can run before its queued cancellation event.
  for (let next = receiveMessageOnPort(port); next; next = receiveMessageOnPort(port)) {
    receive(next.message);
  }
  if (!cancelled) {
    try {
      writeSync(
        2,
        `hard-exit watchdog deadline reached; pending close steps: ${pending}; forcing SIGKILL\n`,
      );
    } finally {
      process.kill(process.pid, "SIGKILL");
    }
  }
}, delayMs);
port.on("message", receive);
