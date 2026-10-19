import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { toPublicCronJob } from "../cron/public-job.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron-records.js";
import type { ClawMutationStateOptions } from "./state-mutation-options.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export type { PersistedClawCronRef } from "./cron-records.js";

export type ClawCronGateway = {
  add: (
    input: Record<string, unknown>,
    options?: { commitGuard?: () => void; existingRef?: PersistedClawCronRef },
  ) => Promise<unknown>;
  get?: (schedulerJobId: string) => Promise<unknown>;
  list?: (agentId: string) => Promise<unknown>;
  remove: (
    schedulerJobId: string,
    options: { commitGuard?: () => void; expectedConfigRevision: string },
  ) => Promise<unknown>;
  waitUntilAgentAvailable?: (agentId: string) => Promise<void>;
};

export class ClawCronInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cronJobs: PersistedClawCronRef[],
  ) {
    super(message);
    this.name = "ClawCronInstallError";
  }
}

function clawCronSchedulerJobFromResult(value: unknown): { id: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) {
    return { id: record.id };
  }
  const job = record.job;
  if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
    return { id: (job as Record<string, unknown>).id as string };
  }
  return undefined;
}

function schedulerJobRecordByDeclarationKey(
  value: unknown,
  declarationKey: string,
): (Record<string, unknown> & { id: string }) | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const jobs = (value as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) {
    return undefined;
  }
  const matches = jobs.filter(
    (job): job is Record<string, unknown> & { id: string } =>
      Boolean(job) &&
      typeof job === "object" &&
      (job as Record<string, unknown>).declarationKey === declarationKey &&
      typeof (job as Record<string, unknown>).id === "string",
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function clawCronGatewayInput(agentId: string, ref: PersistedClawCronRef) {
  const job = ref.job;
  return {
    name: job.name ?? job.id,
    declarationKey: ref.declarationKey,
    ...(job.name ? { displayName: job.name } : {}),
    owner: { agentId },
    enabled: true,
    agentId,
    schedule: {
      kind: "cron",
      expr: job.schedule.cron,
      ...(job.schedule.timezone ? { tz: job.schedule.timezone } : {}),
    },
    sessionTarget: job.session === "main" ? `session:agent:${agentId}:main` : job.session,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.message },
    delivery: job.delivery
      ? {
          mode: job.delivery.mode,
          ...(job.delivery.channel ? { channel: job.delivery.channel } : {}),
        }
      : { mode: "none" },
  };
}

export function clawCronGatewayJobMatchesRef(
  agentId: string,
  ref: PersistedClawCronRef,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const live = cronJobDefinitionFromReadView(value as Partial<CronJob>);
  const expected = normalizeCronJobCreate(clawCronGatewayInput(agentId, ref));
  if (
    !expected ||
    typeof live.id !== "string" ||
    typeof live.createdAtMs !== "number" ||
    typeof live.updatedAtMs !== "number" ||
    !live.state
  ) {
    return false;
  }
  const comparableLive = toPublicCronJob({
    ...live,
    payload: { ...live.payload },
  } as CronStoredJob);
  applyDefaultCronToolsAllow(expected);
  applyDefaultCronToolsAllow(comparableLive);
  const expectedWithPolicy = {
    ...expected,
    ...(comparableLive.scheduledToolPolicy
      ? { scheduledToolPolicy: createTrustedCronScheduledToolPolicy() }
      : {}),
  };
  try {
    return (
      resolveCronJobConfigRevision({
        ...expectedWithPolicy,
        id: live.id,
        createdAtMs: live.createdAtMs,
        updatedAtMs: live.updatedAtMs,
        state: live.state,
      }) === resolveCronJobConfigRevision(comparableLive)
    );
  } catch {
    return false;
  }
}

export function clawCronGatewayJobConfigRevision(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const revision = "configRevision" in value ? value.configRevision : undefined;
  if (typeof revision === "string" && revision.length > 0 && revision.length <= 128) {
    return revision;
  }
  return undefined;
}

/** Add ordinary agent-owned automations without a Claw lifecycle reference. */
export async function installClawCronJobsStateless(
  plan: ClawAddPlan,
  options: ClawMutationStateOptions & {
    assertForwardCurrent?: () => void;
    gateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
    nowMs?: number;
  } = {},
): Promise<PersistedClawCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  if (!options.gateway) {
    throw new ClawCronInstallError(
      "cron_gateway_required",
      "Claw automations require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedClawCronRef[] = [];
  const assertCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  await options.gateway.waitUntilAgentAvailable?.(plan.agent.finalId);
  assertCurrent();
  for (const action of actions) {
    // SAFETY: cronJob plan actions originate from validated ClawCronJob manifest entries.
    const details = action.details as ClawCronJob | undefined;
    if (!details?.id) {
      throw new ClawCronInstallError(
        "cron_plan_invalid",
        `Cron action ${action.id} is invalid.`,
        refs,
      );
    }
    const nowMs = options.nowMs ?? Date.now();
    const ref: PersistedClawCronRef = {
      schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
      agentId: plan.agent.finalId,
      manifestId: details.id,
      declarationKey: `claw:${plan.agent.finalId}:${details.id}`,
      status: "pending",
      job: details,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    let result: { id: string } | undefined;
    try {
      assertCurrent();
      result = clawCronSchedulerJobFromResult(
        await options.gateway.add(clawCronGatewayInput(plan.agent.finalId, ref), {
          commitGuard: assertCurrent,
        }),
      );
      assertCurrent();
      if (!result) {
        throw new Error("cron.add returned no scheduler job id");
      }
    } catch (error) {
      if (options.gateway.list) {
        try {
          const listed = schedulerJobRecordByDeclarationKey(
            await options.gateway.list(plan.agent.finalId),
            ref.declarationKey,
          );
          if (listed && clawCronGatewayJobMatchesRef(plan.agent.finalId, ref, listed)) {
            result = listed;
          }
        } catch {
          // The primary error is more useful when reconciliation is unavailable.
        }
      }
      if (!result) {
        throw new ClawCronInstallError("cron_install_failed", coerceErrorMessage(error), refs);
      }
    }
    refs.push({ ...ref, status: "complete", schedulerJobId: result.id });
  }
  return refs;
}
