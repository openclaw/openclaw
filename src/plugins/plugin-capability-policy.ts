export type PluginActionCapability =
  | "read"
  | "write"
  | "send"
  | "delete"
  | "costly"
  | "private_data"
  | "secret_access"
  | "financial_execution"
  | "destructive";

export type PluginActionPolicyDecision =
  | { kind: "allow"; reason: string }
  | {
      kind: "approval_required";
      reason: string;
      requiredCapabilities: readonly PluginActionCapability[];
    }
  | {
      kind: "deny";
      reason: string;
      deniedCapabilities: readonly PluginActionCapability[];
    };

const approvalRequiredCapabilities = new Set<PluginActionCapability>([
  "write",
  "send",
  "delete",
  "costly",
  "private_data",
  "secret_access",
]);

const deniedCapabilities = new Set<PluginActionCapability>(["financial_execution", "destructive"]);

export function decidePluginActionPolicy(input: {
  pluginId: string;
  actionId?: string;
  capabilities: readonly PluginActionCapability[];
}): PluginActionPolicyDecision {
  if (input.capabilities.length === 0) {
    return {
      kind: "deny",
      reason: "No capabilities declared",
      deniedCapabilities: [],
    };
  }

  const denied = input.capabilities.filter((capability) => deniedCapabilities.has(capability));
  if (denied.length > 0) {
    return {
      kind: "deny",
      reason: "Denied capabilities require a separate security review",
      deniedCapabilities: denied,
    };
  }

  const requiredApproval = input.capabilities.filter((capability) =>
    approvalRequiredCapabilities.has(capability),
  );
  if (requiredApproval.length > 0) {
    return {
      kind: "approval_required",
      reason: "Plugin action uses capabilities that require approval",
      requiredCapabilities: requiredApproval,
    };
  }

  return {
    kind: "allow",
    reason: "Plugin action only declares read capability",
  };
}
