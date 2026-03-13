import { readTextFile, writeTextAtomic } from "../infra/json-files.js";
import type { CronStoreJob } from "./store.js";

export type CronStoreIssueKey =
  | "empty"
  | "invalidSchedule"
  | "invalidPayload"
  | "legacyPayloadKind";

type CronStoreIssues = Record<CronStoreIssueKey, number>;

type NormalizeCronStoreJobsResult = {
  issues: CronStoreIssues;
  jobs: Array<Record<string, unknown>>;
  mutated: boolean;
};

function incrementIssue(issues: CronStoreIssues, key: CronStoreIssueKey) {
  issues[key] = (issues[key] ?? 0) + 1;
}

function normalizePayloadKind(payload: Record<string, unknown>) {
  const raw = typeof payload.kind === "string" ? payload.kind.trim() : "";
  const lower = raw.toLowerCase();
  if (lower === "agentturn") {
    if (raw !== "agentTurn") {
      payload.kind = "agentTurn";
      return true;
    }
    return false;
  }
  if (lower === "systemevent") {
    if (raw !== "systemEvent") {
      payload.kind = "systemEvent";
      return true;
    }
    return false;
  }
  return false;
}

export function normalizeStoredCronJobs(
  jobs: Array<Record<string, unknown>>,
): NormalizeCronStoreJobsResult {
  const issues: CronStoreIssues = {};
  let mutated = false;

  for (const job of jobs) {
    const id = typeof job.id === "string" ? job.id : "";
    if (!id) {
      incrementIssue(issues, "empty");
      continue;
    }

    // Normalize schedule format: {kind: 'once', timestamp} -> {kind: 'once', time}
    const schedule = job.schedule as Record<string, unknown> | undefined;
    if (schedule) {
      if (schedule.kind === "once" && "timestamp" in schedule) {
        schedule.time = schedule.timestamp;
        delete schedule.timestamp;
        mutated = true;
      }
    }

    // Normalize payload kind case
    const payload = job.payload as Record<string, unknown> | undefined;
    if (payload && "kind" in payload) {
      const kindMutated = normalizePayloadKind(payload);
      if (kindMutated) {
        incrementIssue(issues, "legacyPayloadKind");
        mutated = true;
      }
    }
  }

  return { issues, jobs, mutated };
}

export type { CronStoreJob };

export function readCronStore(path: string): Array<Record<string, unknown>> {
  return readTextFile(path) as Array<Record<string, unknown>>;
}

export function writeCronStore(path: string, jobs: Array<Record<string, unknown>>): void {
  void writeTextAtomic(path, jobs);
}
