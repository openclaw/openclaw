import type {
  SecurityMatrixPolicy,
  SecurityMatrixRule,
  SecurityMatrixToolCapability,
  SecurityMatrixTrustSource,
} from "./types.js";

const trustedAllowReason =
  "Trusted operator or agent-originated actions are allowed for known tool capabilities.";
const trustedUnknownReason =
  "Unknown tool capabilities should remain audit-visible even for trusted sources.";
const externalWarnReason =
  "External content influencing read-only or network-visible flows should remain audit-visible.";
const externalRequireConfirmReason =
  "External content influencing state-changing actions should require explicit confirmation in future opt-in runtime modes.";
const externalBlockReason =
  "External content must not directly influence privileged local execution, credential access, or system configuration.";

const trustedCapabilities = [
  "read_file",
  "write_file",
  "network",
  "browser",
  "exec",
  "git",
  "email_send",
  "calendar_write",
  "credential_access",
  "system_config",
  "memory_read",
  "memory_write",
] as const satisfies readonly SecurityMatrixToolCapability[];

const warnCapabilities = [
  "read_file",
  "network",
  "browser",
  "memory_read",
] as const satisfies readonly SecurityMatrixToolCapability[];

const requireConfirmCapabilities = [
  "write_file",
  "git",
  "email_send",
  "calendar_write",
  "memory_write",
  "unknown",
] as const satisfies readonly SecurityMatrixToolCapability[];

const blockCapabilities = [
  "exec",
  "credential_access",
  "system_config",
] as const satisfies readonly SecurityMatrixToolCapability[];

const trustedSources = ["agent", "user"] as const satisfies readonly SecurityMatrixTrustSource[];

const externalSources = [
  "web_fetch",
  "browser",
  "email",
  "file",
  "github",
  "webhook",
  "memory",
  "skill",
  "unknown_external",
] as const satisfies readonly SecurityMatrixTrustSource[];

function createRule(decision: SecurityMatrixRule["decision"], reason: string): SecurityMatrixRule {
  return { decision, reason };
}

function createTrustedPolicy(): SecurityMatrixPolicy {
  const policy: SecurityMatrixPolicy = {};
  for (const source of trustedSources) {
    policy[source] = {};
    for (const capability of trustedCapabilities) {
      policy[source][capability] = createRule("allow", trustedAllowReason);
    }
    policy[source].unknown = createRule("warn", trustedUnknownReason);
  }
  return policy;
}

function createExternalPolicy(): SecurityMatrixPolicy {
  const policy: SecurityMatrixPolicy = {};
  for (const source of externalSources) {
    policy[source] = {};
    for (const capability of warnCapabilities) {
      policy[source][capability] = createRule("warn", externalWarnReason);
    }
    for (const capability of requireConfirmCapabilities) {
      policy[source][capability] = createRule("require_confirm", externalRequireConfirmReason);
    }
    for (const capability of blockCapabilities) {
      policy[source][capability] = createRule("block", externalBlockReason);
    }
  }
  return policy;
}

export const defaultSecurityMatrixPolicy = {
  ...createTrustedPolicy(),
  ...createExternalPolicy(),
} satisfies SecurityMatrixPolicy;
