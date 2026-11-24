import { workerData } from "node:worker_threads";

const caller: unknown = workerData?.caller;
if (typeof caller !== "number") {
  throw new Error("Directory watch parent monitor requires its caller PID");
}

setInterval(() => {
  if (process.ppid !== caller) {
    process.kill(process.pid, "SIGKILL");
  }
}, 1_000);
