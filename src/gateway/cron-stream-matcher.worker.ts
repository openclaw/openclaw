import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../infra/worker-task-server.js";

serveWorkerTasks<boolean>((input) => {
  if (
    !isRecord(input) ||
    typeof input.pattern !== "string" ||
    !Array.isArray(input.lines) ||
    !input.lines.every((line): line is string => typeof line === "string")
  ) {
    throw new Error("invalid cron stream match request");
  }
  // The schedule owner validates patterns; the worker bounds their execution lifetime.
  const matcher = new RegExp(input.pattern);
  return input.lines.some((line) => matcher.test(line));
});
