/** Builds dry-run cron delivery labels for CLI/UI list surfaces. */
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "./agent-id.js";
import { hasExplicitCronDeliveryTarget, resolveCronDeliveryPlan } from "./delivery-plan.js";
import type { CronDeliveryTargetContext } from "./isolated-agent/delivery-target-context.js";
import {
  prepareCronDeliveryTargetContexts,
  resolveDeliveryTarget,
  requiresExternalCronDelivery,
} from "./isolated-agent/delivery-target.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import type { CronDeliveryPreview, CronJob } from "./types.js";

type CronDeliveryPreviewJob = Pick<CronJob, "delivery" | "payload" | "sessionTarget"> &
  Partial<Pick<CronJob, "agentId" | "sessionKey">>;

function formatTarget(channel?: string, to?: string | null): string {
  if (!channel) {
    return "last";
  }
  if (to) {
    return `${channel}:${to}`;
  }
  return channel;
}

function formatDeliveryDetail(params: {
  requestedChannel?: string;
  resolved: boolean;
  sessionKey?: string;
  error?: string;
}): string {
  if (params.requestedChannel === "last" || !params.requestedChannel) {
    if (!params.resolved) {
      return params.error
        ? `last -> no route, will fail-closed: ${params.error}`
        : "last -> no route, will fail-closed";
    }
    return params.sessionKey
      ? `resolved from last, session ${params.sessionKey}`
      : "resolved from last, main session";
  }
  return params.resolved ? "explicit" : (params.error ?? "unresolved");
}

type CronDeliveryPreviewParams = {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  job: CronDeliveryPreviewJob;
};

function prepareCronDeliveryPreview(params: CronDeliveryPreviewParams) {
  const agentId = tryResolveCronJobEffectiveAgentId(
    params.job,
    params.defaultAgentId ?? tryResolveAmbientOwnerAgentId(params.cfg),
  );
  const refusal = agentId ? readAgentDatabaseAdmissionRefusal(agentId) : undefined;
  if (refusal) {
    return {
      preview: {
        label: `agent ${agentId} unavailable`,
        detail: `${refusal.reason}\n${refusal.repairHint}`,
      },
    };
  }
  const plan = resolveCronDeliveryPlan(params.job);
  if (plan.mode === "none" && !hasExplicitCronDeliveryTarget(plan)) {
    return { preview: { label: "not requested", detail: "not requested" } };
  }
  if (plan.mode === "webhook") {
    // Webhook previews do not resolve channel targets; runtime only needs the configured URL.
    const target = plan.to ? `webhook:${plan.to}` : "webhook";
    return { preview: { label: target, detail: plan.to ? "webhook" : "webhook target missing" } };
  }

  const requestedChannel = plan.channel ?? "last";
  if (!agentId) {
    return {
      preview: {
        label: `${plan.mode} -> unresolved owner`,
        detail: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      },
    };
  }
  const sessionTarget =
    params.job.payload.kind === "agentTurn" ? params.job.sessionTarget : undefined;
  const deliverySessionKey = resolveCronDeliverySessionKey(params.job);
  return { plan, requestedChannel, agentId, sessionTarget, deliverySessionKey };
}

async function resolvePreparedCronDeliveryPreview(
  cfg: OpenClawConfig,
  prepared: ReturnType<typeof prepareCronDeliveryPreview>,
  sessionContext?: CronDeliveryTargetContext,
): Promise<CronDeliveryPreview> {
  if (prepared.preview) {
    return prepared.preview;
  }
  const { plan, requestedChannel, agentId, sessionTarget, deliverySessionKey } = prepared;
  const resolved = await resolveDeliveryTarget(
    cfg,
    agentId,
    {
      ...plan,
      sessionTarget,
      sessionKey: deliverySessionKey,
    },
    { dryRun: true, ...(sessionContext ? { sessionContext } : {}) },
  );
  if (!resolved.ok) {
    if (
      sessionTarget === "current" &&
      plan.mode === "announce" &&
      !requiresExternalCronDelivery(plan, resolved)
    ) {
      // Mirrors runtime: a current-target completion with no external channel
      // route commits durably to its own conversation instead of failing.
      return {
        label: "announce -> current session",
        detail: "commits to this conversation (no external channel route)",
      };
    }
    // Preview mirrors runtime fail-closed behavior for "last" delivery so the
    // UI can show unresolved routes before the cron job actually runs.
    return {
      label: `${plan.mode} -> ${formatTarget(requestedChannel, plan.to ?? null)}`,
      detail:
        plan.mode === "none"
          ? `message tool target unresolved: ${resolved.error.message}`
          : formatDeliveryDetail({
              requestedChannel,
              resolved: false,
              sessionKey: deliverySessionKey,
              error: resolved.error.message,
            }),
    };
  }
  return {
    label: `${plan.mode} -> ${formatTarget(resolved.channel, resolved.to)}`,
    detail: formatDeliveryDetail({
      requestedChannel,
      resolved: true,
      sessionKey: deliverySessionKey,
    }),
  };
}

/** Builds the user-visible cron delivery preview for one job without sending anything. */
export async function resolveCronDeliveryPreview(
  params: CronDeliveryPreviewParams,
): Promise<CronDeliveryPreview> {
  return resolvePreparedCronDeliveryPreview(params.cfg, prepareCronDeliveryPreview(params));
}

/** Builds cron delivery previews keyed by job id. */
export async function resolveCronDeliveryPreviews(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  jobs: CronJob[];
}): Promise<Record<string, CronDeliveryPreview>> {
  const prepared = params.jobs.map((job) => prepareCronDeliveryPreview({ ...params, job }));
  const targets = prepared.flatMap((preview, index) =>
    preview.preview
      ? []
      : [{ index, agentId: preview.agentId, sessionKey: preview.deliverySessionKey }],
  );
  const contexts = await prepareCronDeliveryTargetContexts(params.cfg, targets);
  const contextByIndex = new Map(targets.map((target, index) => [target.index, contexts[index]!]));
  const entries = await Promise.all(
    params.jobs.map(async (job, index) => {
      const context = contextByIndex.get(index);
      if (context && !context.ok) {
        throw context.error;
      }
      return [
        job.id,
        await resolvePreparedCronDeliveryPreview(params.cfg, prepared[index]!, context?.value),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}
