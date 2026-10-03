import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
const params: { locks: Record<string, string>; intervalMs: number } = workerData;
const rootPath = Object.keys(params.locks)[0];
const timer = setInterval(() => {
  for (const [lockPath, raw] of Object.entries(params.locks)) {
    if (!fs.existsSync(lockPath) || fs.readFileSync(lockPath, "utf8") !== raw) {
      if (lockPath === rootPath) {
        return;
      }
      continue;
    }
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  }
}, params.intervalMs);
parentPort?.on("message", (message: "stop" | [string, string]) => {
  if (message === "stop") {
    parentPort?.close();
  } else {
    params.locks[message[0]] = message[1];
  }
});
parentPort?.on("close", () => clearInterval(timer));
parentPort?.postMessage(null);
