import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export const MODEL_FALLBACK_NOTICE_KIND = "model-fallback" as const;

/** Transcript-only operational fact; it never changes the selected model. */
export type ModelFallbackNotice = {
  kind: typeof MODEL_FALLBACK_NOTICE_KIND;
  runId: string;
  phase?: "restored";
  fromModel: string;
  toModel: string;
  reason?: string;
};

/** Read only the bounded event fields used by the transcript divider. */
export function readModelFallbackNotice(message: unknown): ModelFallbackNotice | undefined {
  const record = asOptionalRecord(message);
  const marker = asOptionalRecord(record?.openclawDeliveryMirror);
  if (
    record?.role !== "assistant" ||
    marker?.kind !== MODEL_FALLBACK_NOTICE_KIND ||
    (marker.phase !== undefined && marker.phase !== "restored") ||
    typeof marker.runId !== "string" ||
    !marker.runId ||
    marker.runId.length > 4096 ||
    typeof marker.fromModel !== "string" ||
    !marker.fromModel ||
    marker.fromModel.length > 512 ||
    typeof marker.toModel !== "string" ||
    !marker.toModel ||
    marker.toModel.length > 512 ||
    (marker.reason !== undefined &&
      (typeof marker.reason !== "string" || marker.reason.length > 256))
  ) {
    return undefined;
  }
  return {
    kind: MODEL_FALLBACK_NOTICE_KIND,
    runId: marker.runId,
    ...(marker.phase === "restored" ? { phase: "restored" as const } : {}),
    fromModel: marker.fromModel,
    toModel: marker.toModel,
    ...(typeof marker.reason === "string" && marker.reason ? { reason: marker.reason } : {}),
  };
}
