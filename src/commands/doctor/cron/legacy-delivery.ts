// Legacy cron delivery hint migration from top-level payload fields to delivery objects.
import { z } from "zod";
import {
  DeliveryThreadIdFieldSchema,
  LowercaseNonEmptyStringFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
  parseOptionalField,
} from "../../../cron/delivery-field-schemas.js";

function parseLegacyDeliveryHintsInput(payload: Record<string, unknown>) {
  return {
    deliver: parseOptionalField(z.boolean(), payload.deliver),
    bestEffortDeliver: parseOptionalField(z.boolean(), payload.bestEffortDeliver),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.channel),
    provider: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.provider),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, payload.to),
    threadId: parseOptionalField(
      DeliveryThreadIdFieldSchema.transform((value) => String(value)),
      payload.threadId,
    ),
  };
}

/** Normalize delivery and strip consumed legacy delivery fields from the payload. */
export function normalizeLegacyDeliveryInput(params: {
  delivery?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}) {
  const { payload } = params;
  const hints = payload ? parseLegacyDeliveryHintsInput(payload) : undefined;
  if (!payload || !hints || !Object.values(hints).some((value) => value !== undefined)) {
    return {
      delivery: params.delivery ?? undefined,
      mutated: false,
    };
  }

  const next: Record<string, unknown> = {
    ...params.delivery,
    mode: hints.deliver === false ? "none" : "announce",
  };
  if (hints.channel ?? hints.provider) {
    next.channel = hints.channel ?? hints.provider;
  }
  if (hints.to) {
    next.to = hints.to;
  }
  if (hints.threadId) {
    next.threadId = hints.threadId;
  }
  if (hints.bestEffortDeliver !== undefined) {
    next.bestEffort = hints.bestEffortDeliver;
  }
  for (const key of ["deliver", "channel", "provider", "to", "threadId", "bestEffortDeliver"]) {
    delete payload[key];
  }
  return { delivery: next, mutated: true };
}
