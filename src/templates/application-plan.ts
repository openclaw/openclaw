import { digestTemplateValue } from "./digest.js";
import type { TemplateOpenClawAgentSettings } from "./manifest-contract.js";
import type {
  TemplateAddCapabilityChange,
  TemplateAddPlanAction,
  TemplateCronJob,
} from "./types.js";

export function templateAddCapabilityChange(
  change: Omit<
    TemplateAddCapabilityChange,
    "classification" | "requiresDistinctConsent" | "digest"
  >,
): TemplateAddCapabilityChange {
  return {
    ...change,
    classification: "escalation",
    requiresDistinctConsent: true,
    digest: digestTemplateValue(change.effect),
  };
}

export function planTemplateCronJobs({
  automations,
  agentId,
  deviceTimeZone,
  actions,
  capabilityChanges,
}: {
  automations: readonly TemplateCronJob[];
  agentId: string;
  deviceTimeZone?: string;
  actions: TemplateAddPlanAction[];
  capabilityChanges: TemplateAddCapabilityChange[];
}): void {
  // Keep the declared execution session independent from delivery. Templates can only
  // announce to the last channel, which the scheduler rejects on multi-channel hosts,
  // so channel delivery remains an owner choice after Add.
  for (const { delivery: _ignoredDelivery, schedule, ...declaration } of automations) {
    const job = {
      ...declaration,
      schedule: { ...schedule, timezone: deviceTimeZone ?? schedule.timezone },
      agentId,
    };
    actions.push({
      kind: "cronJob",
      id: job.id,
      action: "schedule",
      target: `cron:${job.id}:agent=${agentId}`,
      details: { ...job, expectedState: "absent" },
      blocked: false,
    });
    capabilityChanges.push(
      templateAddCapabilityChange({
        kind: "cronJob",
        id: job.id,
        path: `automations.${job.id}`,
        action: "schedule",
        reason: "The Template declares recurring scheduled work.",
        effect: job,
      }),
    );
  }
}

export function templateAgentCapabilityChange(
  agentId: string,
  settings: TemplateOpenClawAgentSettings,
): TemplateAddCapabilityChange | undefined {
  const effect = {
    ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    ...(settings.tools ? { tools: settings.tools } : {}),
    ...(settings.memory ? { memory: settings.memory } : {}),
    ...(settings.heartbeat ? { heartbeat: settings.heartbeat } : {}),
  };
  if (Object.keys(effect).length === 0) {
    return undefined;
  }
  return templateAddCapabilityChange({
    kind: "agent",
    id: agentId,
    path: "agent",
    action: "create",
    reason:
      "The new agent declares sandbox, tool, memory-search, or recurring heartbeat capabilities.",
    effect,
  });
}
