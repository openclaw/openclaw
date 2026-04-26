import type { ActionSinkPolicyConfig } from "./action-sink-policy-config.js";
import type { PolicyModule, PolicyRequest } from "./action-sink-policy.js";
import { policyResult } from "./action-sink-policy.js";

export type ExternalRiskTier = "internal" | "external" | "customer" | "operator";

export function classifyExternalAction(input: {
  target?: string;
  channel?: string;
  action?: string;
  toolName?: string;
}): ExternalRiskTier {
  const haystack =
    `${input.target ?? ""} ${input.channel ?? ""} ${input.action ?? ""} ${input.toolName ?? ""}`.toLowerCase();
  if (
    /payment|stripe|paypal|zoho|deploy|publish|production|kubectl|aws|gcloud|cloudflare/.test(
      haystack,
    )
  )
    return "operator";
  if (
    /twitter|x\.com|linkedin|facebook|instagram|public|social|email|gmail|smtp|customer/.test(
      haystack,
    )
  )
    return "customer";
  if (
    /telegram|discord|slack|linear|github|gh\b|comment|message|send|reply|react|pin|delete|edit/.test(
      haystack,
    )
  )
    return "external";
  return "internal";
}

function matches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function isExternalActionAllowlisted(
  config: Pick<ActionSinkPolicyConfig, "externalAllowlist">,
  request: PolicyRequest,
): boolean {
  const target = String(request.targetResource ?? request.context?.target ?? "");
  return config.externalAllowlist.some(
    (rule) =>
      matches(rule.targetPattern, target) &&
      (!rule.actionTypes || rule.actionTypes.includes(request.actionType)),
  );
}

export function createExternalActionFirewallModule(
  config: Pick<ActionSinkPolicyConfig, "externalAllowlist">,
): PolicyModule {
  return {
    id: "externalActionFirewall",
    evaluate(request) {
      if (!["message_send", "external_api_write"].includes(request.actionType)) return undefined;
      const tier = classifyExternalAction({
        target: String(request.targetResource ?? ""),
        channel: String(request.context?.channel ?? ""),
        action: String(request.context?.action ?? ""),
        toolName: request.toolName,
      });
      if (tier === "internal" || isExternalActionAllowlisted(config, request)) return undefined;
      return policyResult({
        policyId: "externalActionFirewall",
        decision: "requireApproval",
        reasonCode: "external_write",
        reason: `${tier} outbound action requires approval`,
        correlationId: request.correlationId,
      });
    },
  };
}
