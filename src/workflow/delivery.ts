import crypto from "node:crypto";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WorkflowPlan } from "./types.js";
import { formatWorkflowSummary, getWorkflowProgress } from "./types.js";

const log = createSubsystemLogger("workflow/delivery");

export type WorkflowDeliveryConfig = {
  enabled?: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
};

export function resolveWorkflowDeliveryConfig(): WorkflowDeliveryConfig | null {
  try {
    const cfg = loadConfig();
    const workflowConfig = (cfg as Record<string, unknown>).workflow as
      | Record<string, unknown>
      | undefined;
    if (!workflowConfig) {
      return null;
    }
    const discordConfig = workflowConfig.discordReport as WorkflowDeliveryConfig | undefined;
    if (!discordConfig?.enabled) {
      return null;
    }
    return {
      enabled: true,
      channel: "discord",
      to: discordConfig.channel,
      accountId: discordConfig.accountId,
    };
  } catch {
    return null;
  }
}

export type WorkflowDeliveryResult = {
  delivered: boolean;
  error?: string;
};

export type GatewayOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
};

export async function deliverWorkflowReport(params: {
  plan: WorkflowPlan;
  channel?: string;
  to?: string;
  accountId?: string;
  gatewayOptions?: GatewayOptions;
}): Promise<WorkflowDeliveryResult> {
  const { plan, channel, to, gatewayOptions } = params;

  if (!to) {
    const defaultConfig = resolveWorkflowDeliveryConfig();
    if (!defaultConfig?.to) {
      log.info("workflow delivery skipped: no target configured", { planId: plan.id });
      return { delivered: false, error: "no delivery target configured" };
    }
  }

  const effectiveChannel = channel ?? "discord";
  const effectiveTo = to ?? resolveWorkflowDeliveryConfig()?.to;

  if (!effectiveTo) {
    return { delivered: false, error: "no delivery target" };
  }

  const summary = formatWorkflowSummary(plan);
  const progress = getWorkflowProgress(plan);

  log.info("delivering workflow report", {
    planId: plan.id,
    channel: effectiveChannel,
    to: effectiveTo,
    progress: `${progress.completed}/${progress.total}`,
  });

  try {
    // Use the gateway RPC to send the message
    // This avoids importing complex delivery dependencies
    const { callGatewayTool } = await import("../agents/tools/gateway.js");

    // Generate idempotency key for deduplication
    const idempotencyKey = `workflow-report:${plan.id}:${crypto.randomUUID()}`;

    await callGatewayTool("send", gatewayOptions ?? {}, {
      to: effectiveTo,
      message: summary,
      idempotencyKey,
      channel: effectiveChannel,
      accountId: params.accountId,
    });

    log.info("workflow report delivered", { planId: plan.id });
    return { delivered: true };
  } catch (err) {
    log.warn("workflow report delivery failed", { planId: plan.id, error: String(err) });
    return { delivered: false, error: String(err) };
  }
}

export function buildWorkflowReportText(plan: WorkflowPlan): string {
  return formatWorkflowSummary(plan);
}
