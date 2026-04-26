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
    // `block: true` is terminal; normalize a missing blockReason to a deterministic
    // reason so downstream diagnostics match the `{ allow: false }` path above.
    if ("block" in decision && decision.block === true) {
      return {
        ...decision,
        blockReason: decision.blockReason ?? `blocked by ${registration.policy.id}`,
      };
    }
    // `block: false` is a no-op (matches the regular `before_tool_call` hook
    // pipeline) — it does NOT short-circuit the policy chain. Only return when
    // the policy actually contributed a `params`/`requireApproval` adjustment.
    if ("params" in decision || "requireApproval" in decision) {
      return decision;
    }
  }
  return undefined;
}
