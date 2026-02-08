import { z } from "zod";
import type { HitlApprovalDecision } from "./approval-manager.js";

/**
 * HITL.sh create-request payload (subset used by OpenClaw).
 *
 * We keep this narrowly typed so callers don’t accidentally send secrets in
 * unexpected fields. If HITL adds new fields we need, extend this type.
 */
export type HitlCreateRequestPayload = {
  processing_type?: "time-sensitive";
  type?: "markdown" | "text";
  priority?: "high" | "normal" | "low";
  request_text: string;
  timeout_seconds?: number;
  response_type: "single_select";
  response_config: {
    options: Array<{
      value: HitlApprovalDecision;
      label: string;
    }>;
    required?: boolean;
  };
  default_response: HitlApprovalDecision;
  callback_url?: string;
  platform?: "api";
  context?: Record<string, unknown>;
};

const HitlCreateRequestResponseSchema = z
  .object({
    data: z
      .object({
        request_id: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseHitlCreateRequestResponse(
  raw: unknown,
): { ok: true; requestId: string } | { ok: false; error: string } {
  const parsed = HitlCreateRequestResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "invalid hitl create response" };
  }
  const requestId = parsed.data.data?.request_id?.trim() ?? "";
  if (!requestId) {
    return { ok: false, error: "hitl response missing request_id" };
  }
  return { ok: true, requestId };
}

const HitlWebhookPayloadSchema = z
  .object({
    event: z.string().optional(),
    request_id: z.string().optional(),
    status: z.unknown().optional(),
    response_data: z.unknown().optional(),
    response_by: z.unknown().optional(),
  })
  .passthrough();

function asDecision(value: unknown): HitlApprovalDecision | null {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return null;
}

function extractResolvedBy(payload: z.infer<typeof HitlWebhookPayloadSchema>): string {
  // Best-effort extraction; avoid emails/user ids.
  const responseBy = payload.response_by;
  if (!responseBy || typeof responseBy !== "object") {
    return "hitl";
  }
  const name = (responseBy as { name?: unknown }).name;
  const normalized = typeof name === "string" ? name.trim() : "";
  return normalized || "hitl";
}

export type ParsedHitlWebhookEvent =
  | {
      kind: "completed";
      requestId: string;
      decision: HitlApprovalDecision;
      resolvedBy: string;
    }
  | {
      kind: "default";
      requestId: string;
      resolvedBy: string;
      event: "request.timeout" | "request.cancelled";
    }
  | {
      kind: "ignored";
      requestId: string;
      resolvedBy: string;
      reason: string;
    };

export function parseHitlWebhookPayload(
  body: unknown,
): { ok: true; value: ParsedHitlWebhookEvent } | { ok: false; error: string } {
  const parsed = HitlWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid webhook payload" };
  }
  const event = typeof parsed.data.event === "string" ? parsed.data.event : "";
  const requestId = typeof parsed.data.request_id === "string" ? parsed.data.request_id.trim() : "";
  if (!event || !requestId) {
    return { ok: false, error: "invalid webhook payload" };
  }

  const resolvedBy = extractResolvedBy(parsed.data);

  if (event === "request.completed") {
    const selectedValue =
      parsed.data.response_data && typeof parsed.data.response_data === "object"
        ? (parsed.data.response_data as { selected_value?: unknown }).selected_value
        : undefined;
    const decision = asDecision(selectedValue);
    if (!decision) {
      return {
        ok: true,
        value: { kind: "ignored", requestId, resolvedBy, reason: "unknown decision" },
      };
    }
    return { ok: true, value: { kind: "completed", requestId, decision, resolvedBy } };
  }

  if (event === "request.timeout" || event === "request.cancelled") {
    return { ok: true, value: { kind: "default", requestId, resolvedBy, event } };
  }

  return {
    ok: true,
    value: { kind: "ignored", requestId, resolvedBy, reason: "unknown event" },
  };
}
