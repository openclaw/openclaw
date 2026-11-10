import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStoreStatuses } from "../agents/mcp-oauth-store.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { toPublicCronJob } from "../cron/public-job.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type { TemplateInstallOutcome } from "../shared/template-install-notice.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { TEMPLATE_CRON_REF_SCHEMA_VERSION, type PersistedTemplateCronRef } from "./cron-records.js";
import { digestTemplateBytes } from "./digest.js";
import type { TemplateMutationStateOptions } from "./state-mutation-options.js";
import type { TemplateAddPlan, TemplateCronJob } from "./types.js";
import { readTemplateWorkspaceActionSource } from "./workspace.js";

export type { PersistedTemplateCronRef } from "./cron-records.js";

export type TemplateCronGateway = {
  add: (
    input: Record<string, unknown>,
    options?: { commitGuard?: () => void; existingRef?: PersistedTemplateCronRef },
  ) => Promise<unknown>;
  get?: (schedulerJobId: string) => Promise<unknown>;
  list?: (agentId: string) => Promise<unknown>;
  remove: (
    schedulerJobId: string,
    options: { commitGuard?: () => void; expectedConfigRevision: string },
  ) => Promise<unknown>;
  writeScratch?: (jobId: string, content: string, commitGuard: () => void) => Promise<void>;
  enable?: (
    jobId: string,
    expectedConfigRevision: string,
    commitGuard: () => void,
  ) => Promise<void>;
};

export class TemplateCronInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cronJobs: PersistedTemplateCronRef[],
  ) {
    super(message);
    this.name = "TemplateCronInstallError";
  }
}

function templateCronSchedulerJobFromResult(value: unknown): { id: string } | undefined {
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

function templateCronGatewayInput(agentId: string, ref: PersistedTemplateCronRef) {
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

export function templateCronGatewayJobMatchesRef(
  agentId: string,
  ref: PersistedTemplateCronRef,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const live = cronJobDefinitionFromReadView(value as Partial<CronJob>);
  const expected = normalizeCronJobCreate(templateCronGatewayInput(agentId, ref));
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

export function templateCronGatewayJobConfigRevision(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const revision = "configRevision" in value ? value.configRevision : undefined;
  if (typeof revision === "string" && revision.length > 0 && revision.length <= 128) {
    return revision;
  }
  return undefined;
}

async function templateSchedulesNeedSetup(
  plan: TemplateAddPlan,
  options: TemplateMutationStateOptions,
): Promise<boolean> {
  const env = options.env ?? process.env;
  const requirements = plan.readiness.requirements;
  if (
    requirements.some(
      (requirement) =>
        requirement.kind === "plugin-setup" ||
        (requirement.kind === "environment" && !env[requirement.name]?.trim()),
    )
  ) {
    return true;
  }
  const identities = requirements.flatMap((requirement) => {
    if (requirement.kind !== "oauth") {
      return [];
    }
    const server = plan.actions.find(
      (action) => action.kind === "mcpServer" && action.id === requirement.mcpServer,
    );
    const url = server?.details?.url;
    if (typeof url !== "string") {
      throw new Error("Template OAuth requirement has no declared MCP server URL.");
    }
    return [operatorMcpOAuthIdentity(requirement.mcpServer, url).storeKey];
  });
  if (identities.length === 0) {
    return false;
  }
  const statuses = await readMcpOAuthStoreStatuses(
    identities,
    captureOpenClawStateWorkerContext(options),
  );
  options.assertCurrent?.();
  return statuses.some((status) => status.state !== "authorized");
}

/** Add ordinary agent-owned automations without a Template lifecycle reference. */
export async function installTemplateCronJobsStateless(
  plan: TemplateAddPlan,
  options: TemplateMutationStateOptions & {
    assertForwardCurrent?: () => void;
    gateway?: Pick<TemplateCronGateway, "add" | "list" | "get" | "writeScratch" | "enable">;
    nowMs?: number;
    onSetupOutcome?: (outcome: TemplateInstallOutcome) => Promise<void>;
  } = {},
): Promise<PersistedTemplateCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  if (!options.gateway) {
    throw new TemplateCronInstallError(
      "cron_gateway_required",
      "Template automations require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedTemplateCronRef[] = [];
  const assertCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  assertCurrent();
  // The manifest has no per-routine dependency graph, so unresolved Template-wide
  // setup pauses every declaration. Preserve its exact schedule, prompt and scratch;
  // ordinary automation controls can enable it after the requirement is connected.
  const needsSetup = await templateSchedulesNeedSetup(plan, options);
  assertCurrent();
  let scratchWriteAttempted = false;
  let currentAction = actions[0]!;
  let publishingOutcome = false;
  try {
    for (const action of actions) {
      currentAction = action;
      // SAFETY: cronJob plan actions originate from validated TemplateCronJob manifest entries.
      const details = action.details as TemplateCronJob | undefined;
      if (!action.automation && !details?.id) {
        throw new TemplateCronInstallError(
          "cron_plan_invalid",
          `Cron action ${action.id} is invalid.`,
          refs,
        );
      }
      if (action.source) {
        const source = await readTemplateWorkspaceActionSource({
          action,
          packageRoot: plan.template.packageRoot,
          sourceRoot: await fsSafeRoot(plan.template.packageRoot),
        });
        if (digestTemplateBytes(source.content) !== action.digest) {
          throw new TemplateCronInstallError(
            "cron_source_changed",
            "Portable HEARTBEAT.md changed after consent.",
            refs,
          );
        }
        assertCurrent();
      }
      const plannedJob = action.automation ? { automation: action.automation } : details;
      if (!plannedJob) {
        throw new TemplateCronInstallError(
          "cron_plan_invalid",
          `Cron action ${action.id} is invalid.`,
          refs,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const activateAfterScratch =
        !needsSetup && action.automation?.enabled && action.scratch !== undefined;
      let ref: PersistedTemplateCronRef = {
        schemaVersion: TEMPLATE_CRON_REF_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        manifestId: action.id,
        declarationKey: `template:${plan.agent.finalId}:${action.id}`,
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
      if (needsSetup) {
        const automation = normalizeCronJobCreate(
          templateCronGatewayInput(plan.agent.finalId, ref),
        );
        if (!automation) {
          throw new TemplateCronInstallError(
            "cron_plan_invalid",
            "Template schedule is invalid.",
            refs,
          );
        }
        ref = { ...ref, job: { automation: { ...automation, enabled: false } } };
      }
      let result: { id: string } | undefined;
      try {
        await options.prepareEffect?.();
        assertCurrent();
        result = templateCronSchedulerJobFromResult(
          await options.gateway.add(templateCronGatewayInput(plan.agent.finalId, ref), {
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
            if (listed && templateCronGatewayJobMatchesRef(plan.agent.finalId, ref, listed)) {
              result = listed;
            }
          } catch {
            // The primary error is more useful when reconciliation is unavailable.
          }
        }
        if (!result) {
          throw new TemplateCronInstallError(
            "cron_install_failed",
            coerceErrorMessage(error),
            refs,
          );
        }
      }
      refs.push({ ...ref, status: "complete", schedulerJobId: result.id });
      if (action.scratch !== undefined) {
        if (!options.gateway.writeScratch) {
          throw new TemplateCronInstallError(
            "cron_scratch_import_failed",
            "Template scratch import requires the gateway-owned cron.scratch.set API.",
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
            throw new Error("Template scratch import requires the gateway-owned cron.update API.");
          }
          const live = await options.gateway.get(result.id);
          assertCurrent();
          const revision = templateCronGatewayJobConfigRevision(live);
          if (!revision || !templateCronGatewayJobMatchesRef(plan.agent.finalId, ref, live)) {
            throw new Error("Template automation changed before scratch activation.");
          }
          await options.prepareEffect?.();
          assertCurrent();
          await options.gateway.enable(result.id, revision, assertCurrent);
          ref = { ...ref, job: { automation: action.automation } };
          refs[refs.length - 1] = { ...ref, status: "complete", schedulerJobId: result.id };
        }
      }
      const completed = refs[refs.length - 1]!;
      const job = completed.job;
      assertCurrent();
      publishingOutcome = true;
      await options.onSetupOutcome?.({
        kind: "automation-created",
        declarationId: action.id,
        schedulerJobId: result.id,
        name: "automation" in job ? job.automation.name : (job.name ?? job.id),
        enabled: "automation" in job ? job.automation.enabled : true,
      });
      publishingOutcome = false;
      assertCurrent();
    }
  } catch (error) {
    if (!publishingOutcome) {
      try {
        assertCurrent();
        await options.onSetupOutcome?.({
          kind: "automation-failed",
          declarationId: currentAction.id,
          name: currentAction.automation?.name ?? currentAction.id,
        });
      } catch {
        // Notice delivery must not replace the installer failure or discard retained jobs.
      }
    }
    // Once scratch is exposed, a later Add failure cannot prove that it is still ours.
    throw new TemplateCronInstallError(
      scratchWriteAttempted
        ? "cron_scratch_import_incomplete"
        : error instanceof TemplateCronInstallError
          ? error.code
          : "cron_install_failed",
      coerceErrorMessage(error),
      refs,
    );
  }
  return refs;
}
