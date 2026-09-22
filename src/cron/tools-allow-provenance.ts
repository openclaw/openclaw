import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { CronAuthenticatedChannelRequester } from "../gateway/cron-creator-authority-grant.types.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";
import type { CronStoredJob, CronToolsAllowProvenance } from "./types.js";

/** Authority facts must be authored data, never inherited fields or accessor results. */
function snapshotProvenanceRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable) {
      snapshot[key] = "value" in descriptor ? descriptor.value : undefined;
    }
  }
  return snapshot;
}

export function normalizeCronAuthenticatedChannelRequester(
  value: unknown,
): CronAuthenticatedChannelRequester | undefined {
  const input = snapshotProvenanceRecord(value);
  if (input?.version !== 1) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(input.channel);
  const accountId = normalizeOptionalAccountId(
    typeof input.accountId === "string" ? input.accountId : undefined,
  );
  const senderId = normalizeOptionalString(input.senderId);
  return channel && accountId && senderId
    ? { version: 1, channel, accountId, senderId }
    : undefined;
}

export function normalizeCronToolsAllowProvenance(
  value: unknown,
): CronToolsAllowProvenance | undefined {
  const input = snapshotProvenanceRecord(value);
  if (input?.version !== 1) {
    return undefined;
  }
  const channelRequester = normalizeCronAuthenticatedChannelRequester(input.channelRequester);
  if (input.source === "authenticated-requester") {
    return channelRequester
      ? { version: 1, source: "authenticated-requester", channelRequester }
      : undefined;
  }
  if (input.source !== "final-executable-surface") {
    return undefined;
  }
  return {
    version: 1,
    source: "final-executable-surface",
    callerOrigin: normalizeCronScheduledToolCallerOrigin(
      snapshotProvenanceRecord(input.callerOrigin),
    ),
    ...(channelRequester ? { channelRequester } : {}),
  };
}

/** Requester facts are usable only within the existing job owner and account policy. */
export function resolveCronAuthenticatedChannelRequester(
  job: Pick<CronStoredJob, "payload" | "owner" | "scheduledToolPolicy" | "toolsAllowProvenance">,
): CronAuthenticatedChannelRequester | undefined {
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    owner: job.owner,
    scheduledToolPolicy: job.scheduledToolPolicy,
  });
  if (policy?.mode !== "account") {
    return undefined;
  }
  const requester = normalizeCronToolsAllowProvenance(job.toolsAllowProvenance)?.channelRequester;
  return requester?.accountId === policy.ownerAccountId ? requester : undefined;
}
