import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";

const deadlineNs: unknown = workerData?.deadlineNs;
if (!parentPort || typeof deadlineNs !== "bigint") {
  throw new Error("Shutdown watchdog requires its monotonic deadline");
}

const port = parentPort;
const delayMs = Math.max(0, Number(deadlineNs - process.hrtime.bigint()) / 1_000_000);
const timer = setTimeout(() => {
  // A deadline spent starting this worker can run before its queued cancellation event.
  if (receiveMessageOnPort(port)) {
    port.close();
  } else {
    process.kill(process.pid, "SIGKILL");
  }
}, delayMs);
port.once("message", () => {
  clearTimeout(timer);
  port.close();
});
