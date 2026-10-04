import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import { ChannelThreadBindingsSchema } from "./zod-schema.channel-messaging-common.js";

const SessionResetConfigSchema = z.strictObject({
  mode: z.union([z.literal("none"), z.literal("daily"), z.literal("idle")]).optional(),
  atHour: z.number().int().min(0).max(23).optional(),
  idleMinutes: z.number().int().positive().optional(),
});

const PositiveDurationSchema = z.union([z.string(), z.number()]).superRefine((value, ctx) => {
  try {
    const ms = parseDurationMs(normalizeStringifiedOptionalString(value) ?? "", {
      defaultUnit: "d",
    });
    if (ms <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duration must be positive (use ms, s, m, h, d), e.g. 30d",
      });
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid duration (use ms, s, m, h, d)",
    });
  }
});

const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();

export const SessionSchema = z
  .strictObject({
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    dmScope: z
      .enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"])
      .optional(),
    groupScope: z.enum(["main", "per-group"]).optional(),
    notifyOnCreate: z.boolean().optional(),
    identityLinks: z.record(z.string(), z.array(z.string())).optional(),
    resetTriggers: z.array(z.string()).optional(),
    reset: SessionResetConfigSchema.optional(),
    resetByType: z
      .strictObject({
        direct: SessionResetConfigSchema.optional(),
        group: SessionResetConfigSchema.optional(),
        thread: SessionResetConfigSchema.optional(),
      })
      .optional(),
    resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
    store: z.string().optional(),
    mainKey: z.string().optional(),
    sendPolicy: SessionSendPolicySchema.optional(),
    threadBindings: ChannelThreadBindingsSchema.optional(),
    sharing: z
      .strictObject({
        readOnly: z.boolean().optional(),
        suggest: z.boolean().optional(),
        drafts: z.boolean().optional(),
      })
      .optional(),
    maintenance: z
      .strictObject({
        mode: z.enum(["enforce", "warn"]).optional(),
        coldStorage: z
          .strictObject({
            enabled: z.boolean().optional(),
            afterDays: z.number().int().positive().optional(),
          })
          .optional(),
        pruneAfter: PositiveDurationSchema.optional(),
        archiveDashboardAfter: z
          .union([PositiveDurationSchema, z.literal(false), z.literal(0)])
          .optional(),
        maxEntries: z.number().int().positive().optional(),
        preserveRecent: z.union([PositiveDurationSchema, z.literal(false)]).optional(),
        resetArchiveRetention: z.union([PositiveDurationSchema, z.literal(false)]).optional(),
        maxDiskBytes: z.union([z.string(), z.number(), z.literal(false)]).optional(),
        highWaterBytes: z.union([z.string(), z.number()]).optional(),
      })
      .superRefine((val, ctx) => {
        for (const key of ["maxDiskBytes", "highWaterBytes"] as const) {
          const value = val[key];
          if (value === undefined || value === false) {
            continue;
          }
          try {
            parseByteSize(normalizeStringifiedOptionalString(value) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "invalid size (use b, kb, mb, gb, tb)",
            });
          }
        }
      })
      .optional(),
  })
  .optional();
