import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { ElevatedAllowFromSchema } from "./zod-schema.agent-runtime.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import {
  GroupChatSchema,
  InboundDebounceSchema,
  NativeCommandsSettingSchema,
  QueueSchema,
  TtsConfigSchema,
} from "./zod-schema.core.js";

const SessionResetConfigSchema = z
  .object({
    mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
    atHour: z.number().int().min(0).max(23).optional(),
    idleMinutes: z.number().int().positive().optional(),
  })
  .strict();

export const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();

export const SessionSchema = z
  .object({
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    dmScope: z
      .union([
        z.literal("main"),
        z.literal("per-peer"),
        z.literal("per-channel-peer"),
        z.literal("per-account-channel-peer"),
      ])
      .optional(),
    identityLinks: z.record(z.string(), z.array(z.string())).optional(),
    resetTriggers: z.array(z.string()).optional(),
    idleMinutes: z.number().int().positive().optional(),
    reset: SessionResetConfigSchema.optional(),
    resetByType: z
      .object({
        direct: SessionResetConfigSchema.optional(),
        /** @deprecated Use `direct` instead. Kept for backward compatibility. */
        dm: SessionResetConfigSchema.optional(),
        group: SessionResetConfigSchema.optional(),
        thread: SessionResetConfigSchema.optional(),
      })
      .strict()
      .optional(),
    resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
    store: z.string().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    mainKey: z.string().optional(),
    sendPolicy: SessionSendPolicySchema.optional(),
    agentToAgent: z
      .object({
        maxPingPongTurns: z.number().int().min(0).max(5).optional(),
      })
      .strict()
      .optional(),
    maintenance: z
      .object({
        mode: z.enum(["enforce", "warn"]).optional(),
        pruneAfter: z.union([z.string(), z.number()]).optional(),
        /** @deprecated Use pruneAfter instead. */
        pruneDays: z.number().int().positive().optional(),
        maxEntries: z.number().int().positive().optional(),
        rotateBytes: z.union([z.string(), z.number()]).optional(),
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
      })
      .optional(),
  })
  .strict()
  .optional();

export const MessagesSchema = z
  .object({
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    groupChat: GroupChatSchema,
    queue: QueueSchema,
    inbound: InboundDebounceSchema,
    ackReaction: z.string().optional(),
    ackReactionScope: z.enum(["group-mentions", "group-all", "direct", "all"]).optional(),
    removeAckAfterReply: z.boolean().optional(),
    tts: TtsConfigSchema,
  })
  .strict()
  .optional();

export const CommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional().default("auto"),
    nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
    text: z.boolean().optional(),
    bash: z.boolean().optional(),
    bashForegroundMs: z.number().int().min(0).max(30_000).optional(),
    config: z.boolean().optional(),
    debug: z.boolean().optional(),
    restart: z.boolean().optional(),
    useAccessGroups: z.boolean().optional(),
    ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    allowFrom: ElevatedAllowFromSchema.optional(),
  })
  .strict()
  .optional()
  .default({ native: "auto", nativeSkills: "auto" });
