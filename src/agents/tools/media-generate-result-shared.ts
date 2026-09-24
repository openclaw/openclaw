import type { MediaGenerationNormalizationMetadataInput } from "../../../packages/media-generation-core/src/normalization.js";
import {
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import type { MediaGenerationExecutionResult } from "./media-generate-background-shared.js";

export type MediaGenerateToolExecutionResult = MediaGenerationExecutionResult & {
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
};

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
