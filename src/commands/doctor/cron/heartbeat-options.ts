import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROACTIVE_PROMPT } from "../../../cron/default-proactive-job.js";
import { hasRetiredHeartbeatOptions } from "../../../cron/persisted-shape.js";
import { readDefaultProactiveJobReceiptsByKeyAsync } from "../../../cron/proactive-job-receipt.js";
import { readCronScratchSnapshotByKey } from "../../../cron/scratch-read.js";
import { resolveCronOperatorExecutionRevision } from "../../../cron/service/jobs-tool-policy.js";
import { resolveCronStoreKeyAsync } from "../../../cron/store/paths.js";
import type { CronStoredJob } from "../../../cron/types.js";

/** Change definitions only; the legacy store repair owns backup and compare-and-write. */
export async function migrateRetiredHeartbeatOptions(
  storePath: string,
  jobs: Record<string, unknown>[],
): Promise<string[]> {
  const affected = jobs.filter(hasRetiredHeartbeatOptions);
  if (affected.length === 0) {
    return [];
  }
  const storeKey = await resolveCronStoreKeyAsync(storePath);
  const agents = affected.flatMap((job) => {
    const id = normalizeOptionalString(job.agentId);
    return id ? [id] : [];
  });
  const receipts = await readDefaultProactiveJobReceiptsByKeyAsync(storeKey, agents);
  const notes: string[] = [];
  for (const job of affected) {
    const id = normalizeOptionalString(job.id);
    const agentId = normalizeOptionalString(job.agentId);
    const label = JSON.stringify(normalizeOptionalString(job.name) ?? id ?? "Unnamed automation");
    const payload = asOptionalRecord(job.payload);
    const delivery = asOptionalRecord(job.delivery);
    const storedJob = job as unknown as CronStoredJob;
    const operatorSource = storedJob.operatorSource;
    const skipEmptyScratch = payload?.kind === "agentTurn" && payload.skipIfScratchEmpty === true;
    const retainExecutionRevision =
      typeof operatorSource?.executionRevision === "string" &&
      job.idleOnly !== true &&
      !skipEmptyScratch &&
      operatorSource.executionRevision === resolveCronOperatorExecutionRevision(storedJob);
    const pause: string[] = [];
    const defaultCheck = Boolean(
      agentId &&
      id &&
      receipts[agentId]?.jobId === id &&
      job.name === `Proactive check (${agentId})` &&
      payload?.message === DEFAULT_PROACTIVE_PROMPT,
    );
    if ("idleOnly" in job) {
      if (job.idleOnly === true && !defaultCheck) {
        pause.push("it used to wait until the agent was idle");
      }
      delete job.idleOnly;
      notes.push(`Automation ${label}: removed Wait until idle.`);
    }
    if (payload && "skipIfScratchEmpty" in payload) {
      if (skipEmptyScratch) {
        // A setup job that never had scratch did not skip. Preserve custom jobs'
        // explicit policy, and don't start a setup job that already uses scratch.
        const scratch =
          defaultCheck && id && typeof job.createdAtMs === "number"
            ? await readCronScratchSnapshotByKey(storeKey, {
                kind: "job",
                jobId: id,
                createdAtMsFallback: job.createdAtMs,
              })
            : undefined;
        if (!defaultCheck || scratch?.state.scratch) {
          pause.push("it used to skip runs when scratch was empty");
        }
      }
      delete payload.skipIfScratchEmpty;
      notes.push(`Automation ${label}: removed Skip empty scratch.`);
    }
    if (delivery && normalizeOptionalLowercaseString(delivery.channel) === "last") {
      delete delivery.channel;
      notes.push(`Automation ${label}: kept automatic destination resolution.`);
    }
    if (pause.length > 0 && job.enabled !== false) {
      job.enabled = false;
      notes.push(
        `Paused automation ${label} because ${pause.join(" and ")}. Review its settings before re-enabling it.`,
      );
    }
    if (retainExecutionRevision) {
      storedJob.operatorSource = {
        ...operatorSource,
        executionRevision: resolveCronOperatorExecutionRevision(storedJob),
      };
    }
  }
  return notes;
}
