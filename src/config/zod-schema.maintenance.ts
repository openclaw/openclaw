import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";

export const SessionMaintenanceSchema = z
  .object({
    mode: z.enum(["enforce", "warn"]).optional(),
    pruneAfter: z.union([z.string(), z.number()]).optional(),
    /** @deprecated Use pruneAfter instead. */
    pruneDays: z.number().int().positive().optional(),
    maxEntries: z.number().int().positive().optional(),
    rotateBytes: z.union([z.string(), z.number()]).optional(),
    resetArchiveRetention: z.union([z.string(), z.number(), z.literal(false)]).optional(),
    maxDiskBytes: z.union([z.string(), z.number()]).optional(),
    highWaterBytes: z.union([z.string(), z.number()]).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.pruneAfter !== undefined) {
      try {
        parseDurationMs(String(val.pruneAfter).trim(), { defaultUnit: "d" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pruneAfter"],
          message: "invalid duration (use ms, s, m, h, d)",
        });
      }
    }
    if (val.rotateBytes !== undefined) {
      try {
        parseByteSize(String(val.rotateBytes).trim(), { defaultUnit: "b" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rotateBytes"],
          message: "invalid size (use b, kb, mb, gb, tb)",
        });
      }
    }
    if (val.resetArchiveRetention !== undefined && val.resetArchiveRetention !== false) {
      try {
        parseDurationMs(String(val.resetArchiveRetention).trim(), { defaultUnit: "d" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resetArchiveRetention"],
          message: "invalid duration (use ms, s, m, h, d)",
        });
      }
    }
    if (val.maxDiskBytes !== undefined) {
      try {
        parseByteSize(String(val.maxDiskBytes).trim(), { defaultUnit: "b" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["maxDiskBytes"],
          message: "invalid size (use b, kb, mb, gb, tb)",
        });
      }
    }
    if (val.highWaterBytes !== undefined) {
      try {
        parseByteSize(String(val.highWaterBytes).trim(), { defaultUnit: "b" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["highWaterBytes"],
          message: "invalid size (use b, kb, mb, gb, tb)",
        });
      }
    }
  })
  .optional();
