import { parentPort, workerData } from "node:worker_threads";

const delayMs: unknown = workerData?.delayMs;
if (!parentPort || typeof delayMs !== "number") {
  throw new Error("Shutdown watchdog requires its worker delay");
}

const port = parentPort;
const timer = setTimeout(() => process.kill(process.pid, "SIGKILL"), delayMs);
port.once("message", () => {
  clearTimeout(timer);
  port.close();
});
