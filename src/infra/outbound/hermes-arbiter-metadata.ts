type HermesArbiterScalar = string | number | boolean;

export type HermesArbiterMetadata = {
  arbiter_topic: string;
  arbiter_bot_name: string;
  arbiter_action_type: string;
  arbiter_trace_id: string;
  arbiter_idempotency_key: string;
  [key: `arbiter_${string}`]: HermesArbiterScalar | undefined;
};

export type BuildHermesArbiterMetadataParams = {
  topic: string;
  botName: string;
  traceId: string;
  idempotencyKey: string;
  actionType?: string;
  extra?: Record<string, HermesArbiterScalar | undefined>;
};

const ARBITER_EXTRA_KEY_PATTERN = /^arbiter_[a-z0-9_]+$/;
const RESERVED_KEYS = new Set([
  "arbiter_topic",
  "arbiter_bot_name",
  "arbiter_action_type",
  "arbiter_trace_id",
  "arbiter_idempotency_key",
]);

export function buildHermesArbiterMetadata(
  params: BuildHermesArbiterMetadataParams,
): HermesArbiterMetadata {
  const metadata: HermesArbiterMetadata = {
    arbiter_topic: requiredText(params.topic, "Hermes arbiter topic"),
    arbiter_bot_name: requiredText(params.botName, "Hermes arbiter botName"),
    arbiter_action_type: normalizeOptionalText(params.actionType) ?? "send",
    arbiter_trace_id: requiredText(params.traceId, "Hermes arbiter traceId"),
    arbiter_idempotency_key: requiredText(params.idempotencyKey, "Hermes arbiter idempotencyKey"),
  };

  for (const [key, value] of Object.entries(params.extra ?? {})) {
    if (value === undefined || RESERVED_KEYS.has(key) || !ARBITER_EXTRA_KEY_PATTERN.test(key)) {
      continue;
    }
    metadata[key as `arbiter_${string}`] = value;
  }

  return metadata;
}

function requiredText(value: string, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeOptionalText(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
