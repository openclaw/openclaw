import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { createToolPolicyMatcher } from "../agents/tool-policy-match.js";

/** Remove only the built-in child deny; explicit user policies remain authoritative. */
export function resolvePersonalReminderSubagentPolicy(
  policy: SandboxToolPolicy | undefined,
  configuredDeny: string[],
  admitted: boolean,
): SandboxToolPolicy | undefined {
  return admitted && policy && createToolPolicyMatcher({ deny: configuredDeny })("automations")
    ? { ...policy, deny: policy.deny?.filter((name) => name !== "automations") }
    : policy;
}

export function filterPersonalReminderOwnerDeny(deny: string[], admitted: boolean): string[] {
  return admitted ? deny.filter((name) => name !== "automations") : deny;
}
