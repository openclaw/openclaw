import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "./hook-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export async function runTrustedToolPolicies(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const policies = getActivePluginRegistry()?.trustedToolPolicies ?? [];
  for (const registration of policies) {
    const decision = await registration.policy.evaluate(event, ctx);
    if (!decision) {
      continue;
    }
    if ("allow" in decision && decision.allow === false) {
      return {
        block: true,
        blockReason: decision.reason ?? `blocked by ${registration.policy.id}`,
      };
    }
    if ("block" in decision || "params" in decision || "requireApproval" in decision) {
      return decision;
    }
  }
  return undefined;
}
