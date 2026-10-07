import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAccountCronScheduledToolPolicy,
  normalizeCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
} from "../../../cron/scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../../../cron/tools-allow.js";
import { normalizeOptionalAccountId } from "../../../routing/account-id.js";
import { normalizeAgentId, parseSessionDeliveryRoute } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";

type ScheduledToolPolicyMigrationResult = {
  mutated: boolean;
  ownerReconciled?: boolean;
  status: "current" | "migrated" | "legacy" | "invalid" | "not-applicable";
};

/** Collects operator-visible recovery outcomes while normalizing a cron store. */
export function createScheduledToolPolicyMigrationCollector() {
  const legacyJobs: string[] = [];
  const invalidJobs: string[] = [];
  return {
    legacyJobs,
    invalidJobs,
    migrate(raw: Record<string, unknown>, onMigrated: (kind: "owner" | "policy") => void) {
      const result = migrateScheduledToolPolicy(raw);
      const jobName = normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id);
      if (result.status === "migrated") {
        onMigrated("policy");
      }
      if (result.ownerReconciled) {
        onMigrated("owner");
      }
      if (result.status === "legacy" && jobName) {
        legacyJobs.push(jobName);
      } else if (result.status === "invalid" && jobName) {
        invalidJobs.push(jobName);
      }
      return result.mutated;
    },
  };
}

/** Recovers only account authority proven by immutable persisted owner identity. */
function migrateScheduledToolPolicy(
  raw: Record<string, unknown>,
): ScheduledToolPolicyMigrationResult {
  const payload = readRecord(raw.payload);
  if (!cronJobUsesToolRuntime({ payload, trigger: readRecord(raw.trigger) })) {
    // Retained account restrictions are dormant until the job uses tools again.
    return { mutated: false, status: "not-applicable" };
  }
  const toolsAllow =
    Array.isArray(payload?.toolsAllow) &&
    payload.toolsAllow.every((value): value is string => typeof value === "string")
      ? payload.toolsAllow
      : undefined;
  const owner = readRecord(raw.owner);
  const ownerSessionKey = normalizeOptionalString(owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(
    typeof owner?.accountId === "string" ? owner.accountId : undefined,
  );

  if (raw.scheduledToolPolicy !== undefined) {
    const normalized = normalizeCronScheduledToolPolicy(raw.scheduledToolPolicy);
    const resolved = resolveCronScheduledToolPolicy({
      toolsAllow,
      scheduledToolPolicy: normalized,
      owner: { sessionKey: ownerSessionKey, accountId: ownerAccountId },
    });
    if (!resolved) {
      return { mutated: false, status: "invalid" };
    }
    const mutated = JSON.stringify(raw.scheduledToolPolicy) !== JSON.stringify(resolved);
    if (mutated) {
      raw.scheduledToolPolicy = resolved;
    }
    return { mutated, status: "current" };
  }

  const parsedSession = ownerSessionKey ? parseAgentSessionKey(ownerSessionKey) : undefined;
  if (!ownerSessionKey || !parsedSession) {
    return { mutated: false, status: "legacy" };
  }
  const ownerAgentId = normalizeOptionalString(owner?.agentId);
  if (ownerAgentId && normalizeAgentId(ownerAgentId) !== normalizeAgentId(parsedSession.agentId)) {
    return { mutated: false, status: "legacy" };
  }
  const encodedAccountId = normalizeOptionalAccountId(
    parseSessionDeliveryRoute(ownerSessionKey)?.accountId,
  );
  if (ownerAccountId && encodedAccountId && ownerAccountId !== encodedAccountId) {
    return { mutated: false, status: "legacy" };
  }
  const recoveredAccountId = ownerAccountId ?? encodedAccountId;
  if (!recoveredAccountId) {
    return { mutated: false, status: "legacy" };
  }
  const scheduledToolPolicy = createAccountCronScheduledToolPolicy({
    ownerSessionKey,
    ownerAccountId: recoveredAccountId,
  });
  if (!scheduledToolPolicy) {
    return { mutated: false, status: "legacy" };
  }
  const reconciledOwner = {
    ...owner,
    ...(ownerAgentId ? { agentId: normalizeAgentId(ownerAgentId) } : {}),
    sessionKey: ownerSessionKey,
    accountId: recoveredAccountId,
  };
  const ownerReconciled = JSON.stringify(raw.owner) !== JSON.stringify(reconciledOwner);
  raw.owner = reconciledOwner;
  // Creator identity is recoverable independently of a tool cap. Capless jobs
  // retain legacy execution policy until an explicit permission edit.
  if (!toolsAllow) {
    return { mutated: ownerReconciled, ownerReconciled, status: "legacy" };
  }
  raw.scheduledToolPolicy = scheduledToolPolicy;
  return { mutated: true, ownerReconciled, status: "migrated" };
}
