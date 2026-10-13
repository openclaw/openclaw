import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { MediaGenerationNormalizationMetadataInput } from "../../../packages/media-generation-core/src/normalization.js";
import { extractOriginalFilename, type SavedMedia } from "../../media/store.js";
import {
  formatGeneratedAttachmentLines,
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import type { MediaGenerationExecutionResult } from "./media-generate-background-shared.js";

export type MediaGenerateToolExecutionResult = MediaGenerationExecutionResult & {
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
};

export function buildSavedMediaAttachment<T extends "image" | "audio" | "video">(
  type: T,
  media: SavedMedia,
) {
  return {
    type,
    path: media.path,
    mimeType: media.contentType,
    name: extractOriginalFilename(media.path),
    sizeBytes: media.size,
  };
}

/** Projects generated attachments into the common foreground and completion result contract. */
export function buildMediaGenerateToolExecutionResult(params: {
  kind: "image" | "music" | "video";
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
  messages?: Array<string | null>;
  taskHandle?: { taskId: string; runId: string } | null;
  details: Record<string, unknown>;
}): MediaGenerateToolExecutionResult {
  const { result, attachments, mediaUrls } = params;
  const identity = { provider: result.provider, model: result.model, count: attachments.length };
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
  const label = params.kind === "music" ? "track" : params.kind;
  const contentText = [
    `Generated ${identity.count} ${label}${identity.count === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    ...(params.messages ?? []),
    ...formatGeneratedAttachmentLines(attachments),
  ]
    .filter(Boolean)
    .join("\n");
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
      ...(params.taskHandle
        ? { task: { taskId: params.taskHandle.taskId, runId: params.taskHandle.runId } }
        : {}),
      ...params.details,
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(result.ignoredOverrides?.length ? { ignoredOverrides: result.ignoredOverrides } : {}),
    },
  };
}

export function buildMediaGenerationDurationDetails(
  kind: "music" | "video",
  result: {
    normalization?: MediaGenerationNormalizationMetadataInput;
    metadata?: Record<string, unknown>;
  },
  requestedDuration: number | undefined,
  ignoredOverrides: ReadonlySet<string>,
) {
  const requested =
    result.normalization?.durationSeconds?.requested ??
    asFiniteNumber(result.metadata?.requestedDurationSeconds) ??
    requestedDuration;
  const applied =
    result.normalization?.durationSeconds?.applied ??
    asFiniteNumber(result.metadata?.normalizedDurationSeconds) ??
    (kind === "video"
      ? requested
      : !ignoredOverrides.has("durationSeconds") && typeof requestedDuration === "number"
        ? requestedDuration
        : undefined);
  const changed =
    typeof requested === "number" && typeof applied === "number" && requested !== applied;
  return {
    applied,
    message: changed ? `Duration normalized: requested ${requested}s; used ${applied}s.` : null,
    details: {
      ...(typeof applied === "number" ? { durationSeconds: applied } : {}),
      ...(changed ? { requestedDurationSeconds: requested } : {}),
    },
  };
}

export function buildMediaGenerationGeometryDetails(
  kind: "image" | "video",
  result: {
    normalization?: MediaGenerationNormalizationMetadataInput;
    metadata?: Record<string, unknown>;
    appliedResolution?: string;
  },
  requested: { size?: string; aspectRatio?: string; resolution?: string },
  ignoredOverrides?: ReadonlySet<string>,
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
      result.metadata.requestedSize === requested.size &&
      Boolean(normalizedAspectRatio));
  const appliedResolution =
    kind === "image" ? (result.appliedResolution ?? normalizedResolution) : normalizedResolution;
  const resolutionDetails =
    appliedResolution || (!ignoredOverrides?.has("resolution") && requested.resolution)
      ? { resolution: appliedResolution ?? requested.resolution }
      : {};
  return {
    ...(kind === "image" ? resolutionDetails : {}),
    ...(normalizedSize ||
    (!ignoredOverrides?.has("size") && requested.size && !sizeTranslatedToAspectRatio)
      ? { size: normalizedSize ?? requested.size }
      : {}),
    ...(normalizedAspectRatio || (!ignoredOverrides?.has("aspectRatio") && requested.aspectRatio)
      ? { aspectRatio: normalizedAspectRatio ?? requested.aspectRatio }
      : {}),
    ...(kind === "video" ? resolutionDetails : {}),
  };
}
