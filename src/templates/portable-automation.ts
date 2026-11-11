import { parseDurationMs } from "../cli/parse-duration.js";
import { planHeartbeatTaskMigration } from "../commands/doctor-heartbeat-task-migration.kernel.js";
import { analyzeLegacyHeartbeatTasks } from "../commands/heartbeat-task-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import { assertCronJobScratchContent } from "../cron/scratch-contract.js";
import type { CronJobCreate, CronStoredJob } from "../cron/types.js";
import type { TemplateOpenClawAgentSettings } from "./manifest-contract.js";
import type { TemplateAddPlanAction } from "./types.js";

function createInput(job: CronStoredJob): CronJobCreate {
  const { id: _id, createdAtMs: _created, updatedAtMs: _updated, state: _state, ...input } = job;
  // Add owns the local identity and schedule phase, not the package or its preview.
  if (input.schedule.kind === "every") {
    input.schedule = { kind: "every", everyMs: input.schedule.everyMs };
  }
  return input;
}

/** Deprecated package input becomes ordinary jobs before consent and installation. */
export function planTemplatePortableAutomation(params: {
  actions: TemplateAddPlanAction[];
  heartbeat: TemplateOpenClawAgentSettings["heartbeat"];
  content?: Buffer;
  config: OpenClawConfig;
  agentId: string;
}): void {
  const fileIndex = params.actions.findIndex(
    (action) => action.kind === "workspaceFile" && action.id === "HEARTBEAT.md",
  );
  if (params.heartbeat === undefined && fileIndex < 0) {
    return;
  }
  const heartbeat = params.heartbeat ?? {};
  const file = fileIndex < 0 ? undefined : params.actions.splice(fileIndex, 1)[0];
  const everyMs = parseDurationMs(heartbeat.every ?? "30m", { defaultUnit: "m" });
  const monitor = createDefaultProactiveJob(params.config, params.agentId, 0, everyMs || 1_800_000);
  monitor.id = "$portable-heartbeat";
  monitor.enabled = everyMs > 0;
  monitor.sessionTarget = heartbeat.isolatedSession ? "isolated" : monitor.sessionTarget;
  const activeHours = heartbeat.activeHours;
  // Incomplete legacy windows were unrestricted.
  monitor.activeHours =
    activeHours?.start && activeHours.end
      ? {
          start: activeHours.start,
          end: activeHours.end,
          ...(activeHours.timezone ? { timezone: activeHours.timezone } : {}),
        }
      : undefined;
  if (monitor.payload.kind === "agentTurn") {
    monitor.payload.timeoutSeconds =
      heartbeat.timeoutSeconds ??
      params.config.agents?.defaults?.timeoutSeconds ??
      Math.max(1, Math.min(600, Math.ceil((everyMs || 600_000) / 1000)));
    if (heartbeat.lightContext !== undefined) {
      monitor.payload.lightContext = heartbeat.lightContext;
    }
  }
  let scratch: string | undefined;
  const taskActions: TemplateAddPlanAction[] = [];
  if (params.content) {
    scratch = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(params.content);
    assertCronJobScratchContent(scratch);
    if (analyzeLegacyHeartbeatTasks(scratch).hasTasksBlock) {
      const migration = planHeartbeatTaskMigration({
        snapshot: { jobs: [monitor], sortOrderByJobId: new Map(), nextSortOrder: 0 },
        agentId: params.agentId,
        jobId: monitor.id,
        scratch: { content: scratch, revision: 0, updatedAtMs: 0 },
        nowMs: 0,
      });
      scratch = migration.strippedContent;
      for (const [index, { job }] of migration.jobs.entries()) {
        job.description = "Imported from portable HEARTBEAT.md by Template Add.";
        taskActions.push({
          kind: "cronJob",
          id: `$portable-heartbeat-task-${index + 1}`,
          action: "schedule",
          target: `automation:${params.agentId}`,
          automation: createInput(job),
          blocked: file?.blocked ?? false,
        });
      }
    }
  }
  params.actions.push(
    {
      ...file,
      kind: "cronJob",
      id: "$portable-heartbeat",
      action: "schedule",
      target: `automation:${params.agentId}`,
      automation: createInput(monitor),
      ...(scratch !== undefined ? { scratch } : {}),
      blocked: file?.blocked ?? false,
      reason: monitor.enabled
        ? "Import deprecated heartbeat input as ordinary automations and bounded scratch."
        : "Import deprecated heartbeat input as a disabled automation with its retained cadence and bounded scratch.",
    },
    ...taskActions,
  );
}
