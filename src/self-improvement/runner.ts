import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  createTaskRecord,
  listTaskRecords,
  markTaskTerminalById,
} from "../tasks/runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { auditSelfImprovementOpportunities } from "./auditor.js";
import {
  listSelfImprovementRecommendations,
  upsertSelfImprovementRecommendations,
} from "./store.js";
import { isActiveSelfImprovementStatus } from "./summary.js";
import type { SelfImprovementScanResult, SelfImprovementScanTrigger } from "./types.js";

export async function runSelfImprovementGovernorScan(params: {
  cfg: OpenClawConfig;
  trigger: SelfImprovementScanTrigger;
  stateDir?: string;
  tasks?: TaskRecord[];
  cronJobs?: CronJob[];
  listCronJobs?: () => Promise<CronJob[]>;
  now?: number;
  recordTask?: boolean;
}): Promise<SelfImprovementScanResult> {
  const stateDir = params.stateDir ?? resolveStateDir();
  const now = params.now ?? Date.now();
  const runId = `self-improvement-${now}`;
  const task =
    params.recordTask === false
      ? null
      : createTaskRecord({
          runtime: "cron",
          taskKind: "self-improvement",
          sourceId: "self-improvement-governor",
          requesterSessionKey: "system:self-improvement",
          ownerKey: "system:self-improvement",
          scopeKind: "system",
          runId,
          label: "Self-Improvement Governor scan",
          task: "Inspect OpenClaw state and produce recommendation records.",
          status: "running",
          startedAt: now,
          lastEventAt: now,
          notifyPolicy: "silent",
          userVisible: true,
        });
  try {
    const cronJobs = params.cronJobs ?? (params.listCronJobs ? await params.listCronJobs() : []);
    const audit = await auditSelfImprovementOpportunities({
      cfg: params.cfg,
      stateDir,
      tasks: params.tasks ?? listTaskRecords(),
      cronJobs,
      now,
    });
    const upsert = await upsertSelfImprovementRecommendations({
      stateDir,
      recommendations: audit.recommendations,
    });
    const open = upsert.recommendations.filter((entry) =>
      isActiveSelfImprovementStatus(entry.status),
    ).length;
    const result: SelfImprovementScanResult = {
      scan: {
        scannedAt: now,
        trigger: params.trigger,
        inspected: audit.inspected,
        produced: audit.recommendations.length,
        created: upsert.created,
        updated: upsert.updated,
        reopened: upsert.reopened,
        total: upsert.recommendations.length,
        open,
      },
      recommendations: upsert.recommendations,
    };
    if (task) {
      markTaskTerminalById({
        taskId: task.taskId,
        status: "succeeded",
        endedAt: Date.now(),
        terminalOutcome: "succeeded",
        terminalSummary: `Produced ${audit.recommendations.length} self-improvement recommendation(s).`,
      });
    }
    return result;
  } catch (error) {
    if (task) {
      markTaskTerminalById({
        taskId: task.taskId,
        status: "failed",
        endedAt: Date.now(),
        error: formatErrorMessage(error),
        terminalSummary: "Self-Improvement Governor scan failed.",
      });
    }
    throw error;
  }
}

export async function listStoredSelfImprovementRecommendations(params?: { stateDir?: string }) {
  return await listSelfImprovementRecommendations(params);
}
