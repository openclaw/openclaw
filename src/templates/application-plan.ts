import { digestTemplateValue } from "./digest.js";
import type { TemplateOpenClawAgentSettings } from "./manifest-contract.js";
import type { TemplateAddCapabilityChange } from "./types.js";

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
