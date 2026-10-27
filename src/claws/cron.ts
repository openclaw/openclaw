import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { toPublicCronJob } from "../cron/public-job.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, type PersistedClawCronRef } from "./cron-records.js";
import { digestClawBytes } from "./digest.js";
import type { ClawMutationStateOptions } from "./state-mutation-options.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";
import { readClawWorkspaceActionSource } from "./workspace.js";

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
  writeScratch?: (jobId: string, content: string, commitGuard: () => void) => Promise<void>;
  enable?: (
    jobId: string,
    expectedConfigRevision: string,
    commitGuard: () => void,
  ) => Promise<void>;
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
  if ("automation" in job) {
    return { ...job.automation, declarationKey: ref.declarationKey, owner: { agentId } };
  }
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
  if (
    expected.schedule.kind === "every" &&
    expected.schedule.anchorMs === undefined &&
    live.schedule?.kind === "every"
  ) {
    expected.schedule.anchorMs = live.schedule.anchorMs;
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
    gateway?: Pick<
      ClawCronGateway,
      "add" | "list" | "get" | "waitUntilAgentAvailable" | "writeScratch" | "enable"
    >;
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
  let scratchWriteAttempted = false;
  try {
    for (const action of actions) {
      // SAFETY: cronJob plan actions originate from validated ClawCronJob manifest entries.
      const details = action.details as ClawCronJob | undefined;
      if (!action.automation && !details?.id) {
        throw new ClawCronInstallError(
          "cron_plan_invalid",
          `Cron action ${action.id} is invalid.`,
          refs,
        );
      }
      if (action.source) {
        const source = await readClawWorkspaceActionSource({
          action,
          packageRoot: plan.claw.packageRoot,
          sourceRoot: await fsSafeRoot(plan.claw.packageRoot),
        });
        if (digestClawBytes(source.content) !== action.digest) {
          throw new ClawCronInstallError(
            "cron_source_changed",
            "Portable HEARTBEAT.md changed after consent.",
            refs,
          );
        }
        assertCurrent();
      }
      const plannedJob = action.automation ? { automation: action.automation } : details;
      if (!plannedJob) {
        throw new ClawCronInstallError(
          "cron_plan_invalid",
          `Cron action ${action.id} is invalid.`,
          refs,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const activateAfterScratch = action.automation?.enabled && action.scratch !== undefined;
      let ref: PersistedClawCronRef = {
        schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        manifestId: action.id,
        declarationKey: `claw:${plan.agent.finalId}:${action.id}`,
        status: "pending",
        job: action.automation
          ? {
              automation: {
                ...action.automation,
                ...(activateAfterScratch ? { enabled: false } : {}),
              },
            }
          : plannedJob,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      let result: { id: string } | undefined;
      try {
        await options.prepareEffect?.();
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
      if (action.scratch !== undefined) {
        if (!options.gateway.writeScratch) {
          throw new ClawCronInstallError(
            "cron_scratch_import_failed",
            "Claw scratch import requires the gateway-owned cron.scratch.set API.",
            refs,
          );
        }
        await options.prepareEffect?.();
        assertCurrent();
        scratchWriteAttempted = true;
        await options.gateway.writeScratch(result.id, action.scratch, assertCurrent);
        assertCurrent();
        if (activateAfterScratch && action.automation) {
          if (!options.gateway.get || !options.gateway.enable) {
            throw new Error("Claw scratch import requires the gateway-owned cron.update API.");
          }
          const live = await options.gateway.get(result.id);
          assertCurrent();
          const revision = clawCronGatewayJobConfigRevision(live);
          if (!revision || !clawCronGatewayJobMatchesRef(plan.agent.finalId, ref, live)) {
            throw new Error("Claw automation changed before scratch activation.");
          }
          await options.prepareEffect?.();
          assertCurrent();
          await options.gateway.enable(result.id, revision, assertCurrent);
          ref = { ...ref, job: { automation: action.automation } };
          refs[refs.length - 1] = { ...ref, status: "complete", schedulerJobId: result.id };
        }
      }
    }
  } catch (error) {
    // Once scratch is exposed, a later Add failure cannot prove that it is still ours.
    throw new ClawCronInstallError(
      scratchWriteAttempted
        ? "cron_scratch_import_incomplete"
        : error instanceof ClawCronInstallError
          ? error.code
          : "cron_install_failed",
      coerceErrorMessage(error),
      refs,
    );
  }
  return refs;
}
