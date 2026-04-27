import { z, type ZodType } from "zod";
export declare const DeliveryModeFieldSchema: z.ZodPipe<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
    none: "none";
    announce: "announce";
    webhook: "webhook";
    deliver: "deliver";
}>>, z.ZodTransform<"none" | "announce" | "webhook", "none" | "announce" | "webhook" | "deliver">>;
export declare const LowercaseNonEmptyStringFieldSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodString>;
export declare const TrimmedNonEmptyStringFieldSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodString>;
export declare const DeliveryThreadIdFieldSchema: z.ZodUnion<readonly [z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodString>, z.ZodNumber]>;
export declare const TimeoutSecondsFieldSchema: z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>;
export type ParsedDeliveryInput = {
    mode?: "announce" | "none" | "webhook";
    channel?: string;
    to?: string;
    threadId?: string | number;
    accountId?: string;
};
export declare function parseDeliveryInput(input: Record<string, unknown>): ParsedDeliveryInput;
export declare function parseOptionalField<T>(schema: ZodType<T>, value: unknown): T | undefined;
