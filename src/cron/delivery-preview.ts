/** Builds dry-run cron delivery labels for CLI/UI list surfaces. */
import type { Result } from "@openclaw/normalization-core/result";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { SessionMetadataUnavailableError } from "../state/session-metadata-unavailable-error.js";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "./agent-id.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { hasExplicitCronDeliveryTarget } from "./delivery-target-validation.js";
import type { CronDeliveryTargetContext } from "./isolated-agent/delivery-target-context.js";
import {
  prepareCronDeliveryTargetContexts,
  resolveDeliveryTarget,
  requiresExternalCronDelivery,
  type DeliveryTargetResolution,
} from "./isolated-agent/delivery-target.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import {
  CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
  hasCanonicalCronDeliveryMode,
} from "./store/delivery-codec.js";
import type { CronDeliveryPreview, CronStoredJob } from "./types.js";

type CronDeliveryPreviewJob = Pick<CronStoredJob, "delivery" | "payload" | "sessionTarget"> &
  Partial<Pick<CronStoredJob, "agentId" | "sessionKey" | "sourceConversation">>;

function formatTarget(channel?: string, to?: string | null): string {
  if (!channel) {
    return "last";
  }
  if (to) {
    return `${channel}:${to}`;
  }
  return channel;
}

type CronDeliveryPreviewResolution = CronDeliveryPreview & { failed?: true };

type CronDeliveryPreviewParams = {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  job: CronDeliveryPreviewJob;
};

function prepareCronDeliveryPreview(params: CronDeliveryPreviewParams) {
  if (!hasCanonicalCronDeliveryMode(params.job.delivery)) {
    return {
      preview: {
        label: "delivery requires review",
        detail: CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE,
        failed: true as const,
      },
    };
  }
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
        failed: true as const,
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
    return {
      preview: {
        label: target,
        detail: plan.to ? "webhook" : "webhook target missing",
        ...(!plan.to ? { failed: true as const } : {}),
      },
    };
  }

  const requestedChannel = plan.channel ?? "last";
  if (!agentId) {
    return {
      preview: {
        label: `${plan.mode} -> unresolved owner`,
        detail: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
        failed: true as const,
      },
    };
  }
  const sessionTarget =
    params.job.payload.kind === "agentTurn" ? params.job.sessionTarget : undefined;
  const deliverySessionKey = resolveCronDeliverySessionKey(params.job);
  const sourceConversation = plan.mode === "announce" ? params.job.sourceConversation : undefined;
  return { plan, requestedChannel, agentId, sessionTarget, deliverySessionKey, sourceConversation };
}

async function resolvePreparedCronDeliveryPreview(
  cfg: OpenClawConfig,
  prepared: ReturnType<typeof prepareCronDeliveryPreview>,
  sessionContext?: Result<CronDeliveryTargetContext, unknown>,
): Promise<CronDeliveryPreviewResolution> {
  if (prepared.preview) {
    return prepared.preview;
  }
  const { plan, requestedChannel, agentId, sessionTarget, deliverySessionKey, sourceConversation } =
    prepared;
  let resolved: DeliveryTargetResolution;
  try {
    if (sessionContext && !sessionContext.ok) {
      throw sessionContext.error;
    }
    resolved = await resolveDeliveryTarget(
      cfg,
      agentId,
      {
        ...plan,
        sessionTarget,
        sourceConversation,
        sessionKey: deliverySessionKey,
      },
      { dryRun: true, ...(sessionContext ? { sessionContext: sessionContext.value } : {}) },
    );
  } catch (error) {
    if (!(error instanceof SessionMetadataUnavailableError)) {
      throw error;
    }
    return {
      label: `${plan.mode} -> ${formatTarget(requestedChannel, plan.to ?? null)}`,
      detail: `delivery preview unavailable: ${formatErrorMessage(error)}`,
    };
  }
  if (!resolved.ok) {
    if (
      (sessionTarget === "current" || (sessionTarget === "isolated" && sourceConversation)) &&
      plan.mode === "announce" &&
      !resolved.sourceConversationUnavailable &&
      !requiresExternalCronDelivery(plan, resolved)
    ) {
      return {
        label: `announce -> ${sessionTarget === "current" ? "current session" : "creating conversation"}`,
        detail: "commits to this conversation (no external channel route)",
      };
    }
    const detail =
      plan.mode === "none"
        ? `message tool target unresolved: ${resolved.error.message}`
        : `${requestedChannel === "last" ? "last -> no route, will fail-closed: " : ""}${resolved.error.message}`;
    return {
      label: `${plan.mode} -> ${formatTarget(requestedChannel, plan.to ?? null)}`,
      detail:
        plan.mode === "none"
          ? detail
          : `${detail} Configure a channel and delivery target, or use delivery:{mode:"none"} for no automatic delivery.`,
      ...(plan.mode !== "none" ? { failed: true } : {}),
    };
  }
  return {
    label: `${plan.mode} -> ${formatTarget(resolved.channel, resolved.to)}`,
    detail:
      requestedChannel !== "last"
        ? "explicit"
        : deliverySessionKey
          ? `resolved from last, session ${deliverySessionKey}`
          : "resolved from last, main session",
  };
}

/** Builds the user-visible cron delivery preview for one job without sending anything. */
export async function resolveCronDeliveryPreview(
  params: CronDeliveryPreviewParams,
): Promise<CronDeliveryPreview> {
  const { failed: _failed, ...preview } = await resolvePreparedCronDeliveryPreview(
    params.cfg,
    prepareCronDeliveryPreview(params),
  );
  return preview;
}

/** Reuses the preview decision without adding successful-route bytes to update results. */
export async function resolveCronDeliveryFailurePreview(
  params: CronDeliveryPreviewParams,
): Promise<CronDeliveryPreview | undefined> {
  const { failed, ...preview } = await resolvePreparedCronDeliveryPreview(
    params.cfg,
    prepareCronDeliveryPreview(params),
  );
  return failed ? preview : undefined;
}

/** Builds cron delivery previews keyed by job id. */
export async function resolveCronDeliveryPreviews(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  jobs: CronStoredJob[];
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
      const { failed: _failed, ...preview } = await resolvePreparedCronDeliveryPreview(
        params.cfg,
        prepared[index]!,
        context,
      );
      return [job.id, preview] as const;
    }),
  );
  return Object.fromEntries(entries);
}
