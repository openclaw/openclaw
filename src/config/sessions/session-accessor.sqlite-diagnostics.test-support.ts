import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { flushLogger } from "../../logging/logger.js";

export async function readArtifactPreparationLogs(logPath: string) {
  await flushLogger();
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record)) {
        throw new Error("expected structured writer log");
      }
      const message = record["1"];
      const details = record["2"];
      if (
        (message === "slow SQLite session write" || message === "SQLite session write failed") &&
        isRecord(details) &&
        details.operation === "session.lifecycle.artifacts-prepare"
      ) {
        return [{ message, details }];
      }
      return [];
    });
}
