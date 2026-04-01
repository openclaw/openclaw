import { z, type ZodType } from "zod";

const trimStringPreprocess = (value: unknown) => (typeof value === "string" ? value.trim() : value);

const trimLowercaseStringPreprocess = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

export const DeliveryModeFieldSchema = z
  .preprocess(trimLowercaseStringPreprocess, z.enum(["deliver", "announce", "none", "webhook"]))
  .transform((value) => (value === "deliver" ? "announce" : value));

export const LowercaseNonEmptyStringFieldSchema = z.preprocess(
  trimLowercaseStringPreprocess,
  z.string().min(1),
);

export const TrimmedNonEmptyStringFieldSchema = z.preprocess(
  trimStringPreprocess,
  z.string().min(1),
);

export const DeliveryThreadIdFieldSchema = z.union([
  TrimmedNonEmptyStringFieldSchema,
  z.number().finite(),
]);

export const LegacyDeliveryThreadIdFieldSchema = DeliveryThreadIdFieldSchema.transform((value) =>
  String(value),
);

export const TimeoutSecondsFieldSchema = z
  .number()
  .finite()
  .transform((value) => Math.max(0, Math.floor(value)));

export type ParsedDeliveryInput = {
  mode?: "announce" | "none" | "webhook";
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
};

export function parseDeliveryInput(input: Record<string, unknown>): ParsedDeliveryInput {
  return {
    mode: parseOptionalField(DeliveryModeFieldSchema, input.mode),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, input.channel),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.to),
    threadId: parseOptionalField(DeliveryThreadIdFieldSchema, input.threadId),
    accountId: parseOptionalField(TrimmedNonEmptyStringFieldSchema, input.accountId),
  };
}

export type ParsedLegacyDeliveryHints = {
  deliver?: boolean;
  bestEffortDeliver?: boolean;
  channel?: string;
  provider?: string;
  to?: string;
  threadId?: string;
};

export function parseLegacyDeliveryHintsInput(
  payload: Record<string, unknown>,
): ParsedLegacyDeliveryHints {
  return {
    deliver: parseOptionalField(z.boolean(), payload.deliver),
    bestEffortDeliver: parseOptionalField(z.boolean(), payload.bestEffortDeliver),
    channel: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.channel),
    provider: parseOptionalField(LowercaseNonEmptyStringFieldSchema, payload.provider),
    to: parseOptionalField(TrimmedNonEmptyStringFieldSchema, payload.to),
    threadId: parseOptionalField(LegacyDeliveryThreadIdFieldSchema, payload.threadId),
  };
}

export function parseOptionalField<T>(schema: ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
