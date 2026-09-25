import { joinDiagnosticContent } from "../../infra/diagnostic-content.js";
import type { ReplyPayload } from "../types.js";

/**
 * Extracts the run's visible final answer for captureContent-gated diagnostic
 * content. Reasoning and commentary lanes are display-only or internal detail,
 * never the answer the operator is evaluating, so they are excluded the same
 * way the reply layer filters them before delivery.
 */
/**
 * Joins already-extracted visible answer texts for captureContent-gated
 * diagnostic content. Same bounding and truncation marker as the payload
 * variant.
 */
export function captureDiagnosticResponseTexts(parts: readonly string[]): string | undefined {
  return joinDiagnosticContent(parts, "…[truncated]");
}

export function captureDiagnosticResponse(payloads: readonly ReplyPayload[]): string | undefined {
  const responseParts = payloads
    .filter((payload) => payload.isReasoning !== true && payload.isCommentary !== true)
    .flatMap((payload) =>
      typeof payload.text === "string" && payload.text.trim() ? [payload.text] : [],
    );
  return captureDiagnosticResponseTexts(responseParts);
}
