import { randomUUID } from "node:crypto";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStoreStatuses } from "../agents/mcp-oauth-store.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { toPublicCronJob } from "../cron/public-job.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  readAutomationSavedDefinition,
  type AutomationSavedDefinition,
} from "../shared/automation-saved-definition.js";
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
    options?: {
      commitGuard?: () => void;
      /** Native operation identity; never sourced from the Template. */
      schedulerJobId?: string;
      captureOwnerProfileId?: (ownerProfileId: string | undefined) => void;
    },
  ) => ReturnType<CronServiceContract["add"]>;
  get?: (schedulerJobId: string) => Promise<(CronJob & { configRevision: string }) | undefined>;
  remove: (
    schedulerJobId: string,
    options: { commitGuard?: () => void; expectedConfigRevision: string },
  ) => Promise<unknown>;
  writeScratch?: (jobId: string, content: string, commitGuard: () => void) => Promise<void>;
  enable?: (
    jobId: string,
    expectedConfigRevision: string,
    commitGuard: () => void,
  ) => Promise<CronJob | void>;
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
    enabled: job.enabled ?? true,
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
    ...ref.nativeOwnership,
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
    gateway?: Pick<TemplateCronGateway, "add" | "get" | "writeScratch" | "enable">;
    nowMs?: number;
    onSetupOutcome?: (outcome: TemplateInstallOutcome) => Promise<void>;
  } = {},
): Promise<PersistedTemplateCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  const slots = actions.map((action) => ({
    slotId: action.id,
    name:
      action.automation?.name ??
      (typeof action.details?.name === "string" ? action.details.name : action.id),
  }));
  const refs: PersistedTemplateCronRef[] = [];
  const assertCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  assertCurrent();
  let scratchWriteAttempted = false;
  let settled = 0;
  let created: Extract<TemplateInstallOutcome, { kind: "automation-created" }> | undefined;
  try {
    await options.onSetupOutcome?.({ kind: "automation-plan", slots });
    assertCurrent();
    if (!options.gateway) {
      throw new TemplateCronInstallError(
        "cron_gateway_required",
        "Template automations require the gateway-owned cron.add API.",
        refs,
      );
    }
    // Unresolved Template-wide setup pauses every declaration, preserving its schedule and scratch.
    const needsSetup = await templateSchedulesNeedSetup(plan, options);
    assertCurrent();
    for (const action of actions) {
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
      const schedulerJobId = randomUUID();
      let confirmed: boolean;
      let definition: AutomationSavedDefinition | undefined;
      try {
        await options.prepareEffect?.();
        assertCurrent();
        const added = await options.gateway.add(templateCronGatewayInput(plan.agent.finalId, ref), {
          commitGuard: assertCurrent,
          schedulerJobId,
          captureOwnerProfileId: (ownerProfileId) => {
            ref = { ...ref, nativeOwnership: { ownerProfileId } };
          },
        });
        confirmed = added?.id === schedulerJobId && !("created" in added && !added.created);
        if (confirmed) {
          const saved = "job" in added ? added.job : added;
          definition = readAutomationSavedDefinition(
            { ...saved, configRevision: resolveCronJobConfigRevision(saved) },
            schedulerJobId,
          );
        }
      } catch (error) {
        // A lost acknowledgement may follow a commit. A declaration key, even
        // with identical settings and owner, cannot identify this attempt.
        const live =
          ref.nativeOwnership &&
          (await options.gateway.get?.(schedulerJobId).catch(() => undefined));
        if (
          live?.id !== schedulerJobId ||
          !templateCronGatewayJobMatchesRef(plan.agent.finalId, ref, live)
        ) {
          throw new TemplateCronInstallError(
            "cron_install_failed",
            coerceErrorMessage(error),
            refs,
          );
        }
        confirmed = true;
        definition = readAutomationSavedDefinition(live, schedulerJobId);
      }
      if (!confirmed) {
        throw new TemplateCronInstallError(
          "cron_install_failed",
          "cron.add did not confirm creation of the requested scheduler job",
          refs,
        );
      }
      refs.push({ ...ref, status: "complete", schedulerJobId });
      // The scheduler has created this job even if importing scratch or enabling
      // it subsequently fails. The rollback owner decides whether its ID survives.
      const job = ref.job;
      created = {
        kind: "automation-created",
        ...(definition ? { definition } : {}),
        declarationId: action.id,
        schedulerJobId,
        name: "automation" in job ? job.automation.name : (job.name ?? job.id),
        enabled: "automation" in job ? job.automation.enabled : (job.enabled ?? true),
      };
      assertCurrent();
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
        await options.gateway.writeScratch(schedulerJobId, action.scratch, assertCurrent);
        assertCurrent();
        if (activateAfterScratch && action.automation) {
          if (!options.gateway.get || !options.gateway.enable) {
            throw new Error("Template scratch import requires the gateway-owned cron.update API.");
          }
          const live = await options.gateway.get(schedulerJobId);
          assertCurrent();
          const revision = templateCronGatewayJobConfigRevision(live);
          if (!revision || !templateCronGatewayJobMatchesRef(plan.agent.finalId, ref, live)) {
            throw new Error("Template automation changed before scratch activation.");
          }
          await options.prepareEffect?.();
          assertCurrent();
          delete created.definition;
          const enabledJob = await options.gateway.enable(schedulerJobId, revision, assertCurrent);
          if (enabledJob) {
            created.definition = readAutomationSavedDefinition(
              { ...enabledJob, configRevision: resolveCronJobConfigRevision(enabledJob) },
              schedulerJobId,
            );
          }
          created.enabled = true;
          ref = { ...ref, job: { automation: action.automation } };
          refs[refs.length - 1] = { ...ref, status: "complete", schedulerJobId };
        }
      }
      assertCurrent();
      await options.onSetupOutcome?.(created);
      settled++;
      created = undefined;
      assertCurrent();
    }
  } catch (error) {
    // No slot stays pending after a terminal install error. On publication failure,
    // replay the completed slot's exact idempotent receipt, never a false failure.
    for (const slot of slots.slice(settled)) {
      try {
        assertCurrent();
        await options.onSetupOutcome?.(
          created ?? { kind: "automation-failed", declarationId: slot.slotId, name: slot.name },
        );
      } catch {
        // Notice delivery must not replace the installer failure or discard retained jobs.
      }
      created = undefined;
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
