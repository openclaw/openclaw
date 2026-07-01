export const DURABLE_INTAKE_ENVELOPE_SCHEMA = "openclaw.durable.intake-envelope.v1";

const DEFAULT_PREVIEW_LIMIT = 600;
const DEFAULT_INLINE_TEXT_LIMIT = 16_384;

export type DurableIntakeEnvelopeReplay = {
  inputAvailability: "metadata_only" | "preview_only" | "inline_snapshot";
  canReplay: boolean;
  reason: string;
  contextManifestRef?: string;
};

export type DurableIntakeEnvelope = {
  schema: typeof DURABLE_INTAKE_ENVELOPE_SCHEMA;
  operationKind: string;
  runId: string;
  sourceType: string;
  sourceRef?: string;
  agentId?: string;
  sessionKey?: string;
  transport?: string;
  deliver?: boolean;
  message: {
    length: number;
    hash: string;
    preview?: string;
    previewTruncated?: boolean;
    text?: string;
  };
  attachmentCount?: number;
  contextRefs?: readonly Record<string, unknown>[];
  contextManifestRef?: string;
  replay: DurableIntakeEnvelopeReplay;
};

export function shouldStoreFullDurableInputText(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENCLAW_DURABLE_INPUT_TEXT;
  return raw === "full" || raw === "inline";
}

function resolvePreviewLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_DURABLE_INPUT_PREVIEW_CHARS;
  if (!raw) {
    return DEFAULT_PREVIEW_LIMIT;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PREVIEW_LIMIT;
}

function resolveInlineTextLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_DURABLE_INPUT_FULL_MAX_CHARS;
  if (!raw) {
    return DEFAULT_INLINE_TEXT_LIMIT;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INLINE_TEXT_LIMIT;
}

function previewText(value: string, limit: number): { preview?: string; truncated?: boolean } {
  if (limit <= 0) {
    return {};
  }
  if (value.length <= limit) {
    return { preview: value, truncated: false };
  }
  return { preview: value.slice(0, limit), truncated: true };
}

export function buildDurableIntakeEnvelope(params: {
  operationKind: string;
  runId: string;
  sourceType: string;
  sourceRef?: string;
  agentId?: string;
  sessionKey?: string;
  transport?: string;
  deliver?: boolean;
  message: string;
  messageHash: string;
  attachmentCount?: number;
  contextRefs?: readonly Record<string, unknown>[];
  contextManifestRef?: string;
  env?: NodeJS.ProcessEnv;
}): DurableIntakeEnvelope {
  const env = params.env ?? process.env;
  const preview = previewText(params.message, resolvePreviewLimit(env));
  const shouldStoreFull = shouldStoreFullDurableInputText(env);
  const inlineTextLimit = resolveInlineTextLimit(env);
  const canInlineText = shouldStoreFull && params.message.length <= inlineTextLimit;
  const replay: DurableIntakeEnvelopeReplay = {
    ...(canInlineText
      ? {
          inputAvailability: "inline_snapshot" as const,
          canReplay: true,
          reason: "full input text is stored inline in the durable intake envelope",
        }
      : preview.preview !== undefined
        ? {
            inputAvailability: "preview_only" as const,
            canReplay: false,
            reason: shouldStoreFull
              ? "input text exceeded the configured durable inline snapshot limit"
              : "durable input stores a bounded preview by default; retry requires the source session or caller",
          }
        : {
            inputAvailability: "metadata_only" as const,
            canReplay: false,
            reason: "durable input text snapshot is disabled",
          }),
    ...(params.contextManifestRef ? { contextManifestRef: params.contextManifestRef } : {}),
  };

  return {
    schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
    operationKind: params.operationKind,
    runId: params.runId,
    sourceType: params.sourceType,
    ...(params.sourceRef ? { sourceRef: params.sourceRef } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.transport ? { transport: params.transport } : {}),
    ...(params.deliver !== undefined ? { deliver: params.deliver } : {}),
    message: {
      length: params.message.length,
      hash: params.messageHash,
      ...(preview.preview !== undefined ? { preview: preview.preview } : {}),
      ...(preview.truncated !== undefined ? { previewTruncated: preview.truncated } : {}),
      ...(canInlineText ? { text: params.message } : {}),
    },
    ...(params.attachmentCount !== undefined ? { attachmentCount: params.attachmentCount } : {}),
    ...(params.contextRefs && params.contextRefs.length > 0
      ? { contextRefs: params.contextRefs }
      : {}),
    ...(params.contextManifestRef ? { contextManifestRef: params.contextManifestRef } : {}),
    replay,
  };
}
