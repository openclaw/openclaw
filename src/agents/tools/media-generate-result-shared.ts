import type { MediaGenerationNormalizationMetadataInput } from "../../../packages/media-generation-core/src/normalization.js";
import {
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import type { MediaGenerationExecutionResult } from "./media-generate-background-shared.js";
import { buildTaskRunDetails } from "./media-tool-shared.js";

export type MediaGenerateToolExecutionResult = MediaGenerationExecutionResult & {
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
};

/** Projects generated attachments into the common foreground and completion result contract. */
export function buildMediaGenerateToolExecutionResult(params: {
  result: {
    provider: string;
    model: string;
    attempts: readonly { provider: string; model: string; error: string }[];
    normalization?: MediaGenerationNormalizationMetadataInput;
    metadata?: Record<string, unknown>;
    ignoredOverrides?: readonly { key: string; value: string | boolean | number }[];
  };
  attachments: AgentGeneratedAttachment[];
  mediaUrls: string[];
  lines: string[];
  taskHandle?: { taskId: string; runId: string } | null;
  warning?: string;
  details: Record<string, unknown>;
}): MediaGenerateToolExecutionResult {
  const { result, attachments, mediaUrls, warning } = params;
  const identity = { provider: result.provider, model: result.model, count: attachments.length };
  const contentText = params.lines.join("\n");
  return {
    ...identity,
    attachments,
    contentText,
    wakeResult: contentText,
    details: {
      ...identity,
      media: { mediaUrls, attachments },
      attachments,
      paths: mediaUrls,
      ...buildTaskRunDetails(params.taskHandle),
      ...params.details,
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(result.ignoredOverrides?.length ? { ignoredOverrides: result.ignoredOverrides } : {}),
    },
  };
}

export function describeMediaGenerationResult(result: {
  provider: string;
  model: string;
  ignoredOverrides?: readonly { key: string; value: string | boolean | number }[];
}) {
  const displayProvider = sanitizeGeneratedMediaDisplayText(result.provider);
  const displayModel = sanitizeGeneratedMediaDisplayText(result.model);
  const overrides = result.ignoredOverrides ?? [];
  const warning =
    overrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${overrides
          .map(
            (entry) =>
              `${sanitizeGeneratedMediaDisplayText(entry.key)}=${sanitizeGeneratedMediaDisplayText(String(entry.value))}`,
          )
          .join(", ")}.`
      : undefined;
  return { displayProvider, displayModel, warning };
}

export function resolveMediaGenerationResultGeometry(
  result: {
    normalization?: MediaGenerationNormalizationMetadataInput;
    metadata?: Record<string, unknown>;
  },
  requestedSize?: string,
) {
  const readMetadataString = (key: string) => {
    const value = result.metadata?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const normalizedSize =
    result.normalization?.size?.applied ?? readMetadataString("normalizedSize");
  const normalizedAspectRatio =
    result.normalization?.aspectRatio?.applied ?? readMetadataString("normalizedAspectRatio");
  const normalizedResolution =
    result.normalization?.resolution?.applied ?? readMetadataString("normalizedResolution");
  const sizeTranslatedToAspectRatio =
    result.normalization?.aspectRatio?.derivedFrom === "size" ||
    (!normalizedSize &&
      typeof result.metadata?.requestedSize === "string" &&
      result.metadata.requestedSize === requestedSize &&
      Boolean(normalizedAspectRatio));
  return {
    normalizedSize,
    normalizedAspectRatio,
    normalizedResolution,
    sizeTranslatedToAspectRatio,
  };
}
