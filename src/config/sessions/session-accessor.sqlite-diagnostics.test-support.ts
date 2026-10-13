import assert from "node:assert/strict";
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { flushLogger } from "../../logging/logger.js";
import { preparedSharingReads } from "./session-accessor.sqlite-entry-cache-publication-state.js";

export function assertNoRetainedSessionSharingReads(): void {
  const retained = [...preparedSharingReads.values()].reduce(
    (count, reads) => count + reads.size,
    0,
  );
  assert.equal(retained, 0, "Completed handlers must release retained session sharing facts");
}

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
      const message = record["2"];
      const details = record["1"];
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
