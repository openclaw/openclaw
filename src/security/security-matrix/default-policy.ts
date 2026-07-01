import type {
  SecurityMatrixInfluenceSource,
  SecurityMatrixPolicy,
  SecurityMatrixPolicySource,
  SecurityMatrixRule,
  SecurityMatrixToolCapability,
} from "./types.js";

const noExternalAllowReason =
  "No external-content influence is present; known capabilities defer to the existing operator tool policy.";
const noExternalUnknownReason =
  "Unknown tool capabilities remain audit-visible even when no external influence is present.";
const externalWarnReason =
  "External content influencing read-only or network-visible flows should remain audit-visible.";
const externalRequireConfirmReason =
  "External content influencing state-changing actions should require explicit confirmation in future opt-in runtime modes.";
const externalBlockReason =
  "External content must not directly influence privileged local execution, credential access, or system configuration.";

const knownCapabilities = [
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

const externalSources = [
  "web_fetch",
  "browser",
  "email",
  "file",
  "github",
  "webhook",
  "memory",
  "skill",
  "api",
  "channel_metadata",
  "unknown_external",
] as const satisfies readonly SecurityMatrixInfluenceSource[];

function createRule(decision: SecurityMatrixRule["decision"], reason: string): SecurityMatrixRule {
  return { decision, reason };
}

function createNoExternalPolicy(): SecurityMatrixPolicy {
  const sourcePolicy: NonNullable<SecurityMatrixPolicy["none"]> = {};
  for (const capability of knownCapabilities) {
    sourcePolicy[capability] = createRule("allow", noExternalAllowReason);
  }
  sourcePolicy.unknown = createRule("warn", noExternalUnknownReason);
  return { none: sourcePolicy };
}

function createExternalPolicy(): SecurityMatrixPolicy {
  const policy: SecurityMatrixPolicy = {};
  for (const source of externalSources) {
    const sourcePolicy: NonNullable<SecurityMatrixPolicy[SecurityMatrixPolicySource]> = {};
    for (const capability of warnCapabilities) {
      sourcePolicy[capability] = createRule("warn", externalWarnReason);
    }
    for (const capability of requireConfirmCapabilities) {
      sourcePolicy[capability] = createRule("require_confirm", externalRequireConfirmReason);
    }
    for (const capability of blockCapabilities) {
      sourcePolicy[capability] = createRule("block", externalBlockReason);
    }
    policy[source] = sourcePolicy;
  }
  return policy;
}

export const defaultSecurityMatrixPolicy = {
  ...createNoExternalPolicy(),
  ...createExternalPolicy(),
} satisfies SecurityMatrixPolicy;
