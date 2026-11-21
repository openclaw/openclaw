import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../infra/worker-task-server.js";

serveWorkerTasks<boolean>((input) => {
  if (!isRecord(input) || typeof input.pattern !== "string" || !isStringArray(input.lines)) {
    throw new Error("invalid cron stream match request");
  }
  // The schedule owner validates patterns; the worker bounds their execution lifetime.
  const matcher = new RegExp(input.pattern);
  return input.lines.some((line) => matcher.test(line));
});
