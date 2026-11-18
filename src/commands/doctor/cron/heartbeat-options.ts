import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROACTIVE_PROMPT } from "../../../cron/default-proactive-job.js";
import { hasRetiredHeartbeatOptions } from "../../../cron/persisted-shape.js";
import { readDefaultProactiveJobReceiptsByKeyAsync } from "../../../cron/proactive-job-receipt.js";
import { compareCronRunRecordsNewestFirst } from "../../../cron/run-history-detail.js";
import { readCronScratchSnapshotByKey } from "../../../cron/scratch-read.js";
import { resolveCronStoreKeyAsync } from "../../../cron/store/paths.js";
import {
  readCronRunHistoryCandidates,
  readCronRunHistoryRecords,
} from "../../../cron/store/read-only.js";

async function lastDeliveredRoute(storeKey: string, jobId: string) {
  const { records } = await readCronRunHistoryCandidates(storeKey, jobId);
  const ordered = records.toSorted(compareCronRunRecordsNewestFirst);
  for (let offset = 0; offset < ordered.length; offset += 100) {
    const page = await readCronRunHistoryRecords(
      storeKey,
      ordered.slice(offset, offset + 100).map((row) => row.id),
    );
    for (const row of page.toSorted(compareCronRunRecordsNewestFirst)) {
      const trace = asOptionalRecord(asOptionalRecord(row.detail)?.delivery);
      if (trace?.delivered !== true) {
        continue;
      }
      const receipt = Array.isArray(trace.receipts)
        ? asOptionalRecord(trace.receipts.at(-1))
        : undefined;
      const resolved = asOptionalRecord(trace.resolved);
      // A resolved route is only evidence if the run actually delivered there.
      // An unverified message-tool send may have delivered somewhere else.
      const target =
        receipt ?? (resolved?.ok === true && !trace.messageToolSentTo ? resolved : undefined);
      const channel = normalizeOptionalLowercaseString(target?.channel);
      const to = normalizeOptionalString(target?.to);
      if (channel && channel !== "last" && channel !== "none" && channel !== "webchat" && to) {
        return {
          channel,
          to,
          accountId: normalizeOptionalString(target?.accountId),
          threadId:
            typeof target?.threadId === "number" || typeof target?.threadId === "string"
              ? target.threadId
              : undefined,
        };
      }
    }
  }
  return undefined;
}

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
      if (payload.kind === "agentTurn" && payload.skipIfScratchEmpty === true) {
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
    if (delivery && "directPolicy" in delivery) {
      if (delivery.directPolicy === "block" && delivery.mode !== "webhook") {
        pause.push("it used to block direct messages and could now send them");
      }
      delete delivery.directPolicy;
      notes.push(`Automation ${label}: removed the direct-message policy.`);
    }
    if (delivery && normalizeOptionalLowercaseString(delivery.channel) === "last") {
      delete delivery.channel;
      if (delivery.target === "owner") {
        notes.push(`Automation ${label}: kept automatic owner direct-message delivery.`);
      } else {
        const route =
          id && delivery.mode === "announce" ? await lastDeliveredRoute(storeKey, id) : undefined;
        if (route) {
          delete delivery.accountId;
          delete delivery.threadId;
          Object.assign(delivery, route);
          notes.push(
            `Automation ${label}: pinned delivery to its last recorded successful destination (${route.channel}).`,
          );
        } else {
          notes.push(
            `Automation ${label}: no previous delivery destination was recorded; using normal destination resolution.`,
          );
        }
      }
    }
    if (pause.length > 0 && job.enabled !== false) {
      job.enabled = false;
      notes.push(
        `Paused automation ${label} because ${pause.join(" and ")}. Review its settings before re-enabling it.`,
      );
    }
  }
  return notes;
}
