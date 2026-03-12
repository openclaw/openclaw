import { createHash } from "node:crypto";
import type { SlackMessageEvent } from "../types.js";
import type { SlackChannelConfigResolved } from "./channel-config.js";

const RESOLVED_INCIDENT_REGEX =
  // BetterStack-style resolved/recovered status updates we want to suppress on
  // monitoring channels. This intentionally prefers operational filtering over
  // perfect natural-language precision.
  /\b(status\s*[:=-]?\s*resolved|incident\s+resolved|alert\s+resolved|monitor(?:ing)?\s+recovered|recovered)\b/i;
const MAX_INCIDENT_DEDUPE_FINGERPRINTS = 512;

function isRootSlackIncidentMessage(message: SlackMessageEvent) {
  // Slack thread roots either have no thread_ts yet or report thread_ts === ts
  // with no parent_user_id.
  return !message.thread_ts || (message.thread_ts === message.ts && !message.parent_user_id);
}

function normalizeIncidentFingerprintInput(rawBody: string) {
  return rawBody
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function createIncidentFingerprint(normalizedRawBody: string) {
  return createHash("sha256").update(normalizedRawBody).digest("hex").slice(0, 16);
}

function pruneExpiredFingerprints(store: Map<string, number>, now: number) {
  for (const [key, expiresAt] of store) {
    if (expiresAt <= now) {
      store.delete(key);
    }
  }
}

function enforceFingerprintStoreLimit(store: Map<string, number>) {
  while (store.size > MAX_INCIDENT_DEDUPE_FINGERPRINTS) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) {
      return;
    }
    store.delete(oldestKey);
  }
}

export function resolveSlackIncidentIngressDrop(params: {
  accountId: string;
  channelConfig: SlackChannelConfigResolved | null;
  channelId: string;
  dedupeStore: Map<string, number>;
  message: SlackMessageEvent;
  now?: number;
  rawBody: string;
}): { reason?: string; shouldDrop: boolean } {
  const { channelConfig } = params;
  if (!channelConfig) {
    return { shouldDrop: false };
  }

  if (channelConfig.incidentRootOnly && !isRootSlackIncidentMessage(params.message)) {
    return { shouldDrop: true, reason: "incident-non-root-update" };
  }

  if (channelConfig.incidentIgnoreResolved && RESOLVED_INCIDENT_REGEX.test(params.rawBody)) {
    return { shouldDrop: true, reason: "incident-resolved-update" };
  }

  if (channelConfig.incidentDedupeWindowSeconds <= 0) {
    return { shouldDrop: false };
  }

  const normalized = normalizeIncidentFingerprintInput(params.rawBody);
  if (!normalized) {
    return { shouldDrop: false };
  }

  const now = params.now ?? Date.now();
  pruneExpiredFingerprints(params.dedupeStore, now);
  const fingerprint = createIncidentFingerprint(normalized);
  const key = `${params.accountId}:${params.channelId}:${fingerprint}`;
  const previousExpiry = params.dedupeStore.get(key);
  if (previousExpiry && previousExpiry > now) {
    return { shouldDrop: true, reason: "incident-duplicate" };
  }

  params.dedupeStore.set(key, now + channelConfig.incidentDedupeWindowSeconds * 1000);
  enforceFingerprintStoreLimit(params.dedupeStore);
  return { shouldDrop: false };
}
