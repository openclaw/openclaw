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
  TypingModeSchema,
  TtsConfigSchema,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const SessionResetConfigSchema = z
  .object({
    mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
    atHour: z.number().int().min(0).max(23).optional(),
    idleMinutes: z.number().int().positive().optional(),
  })
  .strict();

export const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();

const SessionRelayRoutingModeSchema = z.enum(["read-write", "read-only"]);

const SessionRelayRoutingTargetSchema = z
  .object({
    channel: z.string().min(1),
    to: z.string().min(1),
    accountId: z.string().optional(),
  })
  .strict();

export const SessionRelayRoutingMatchSchema = z
  .object({
    channel: z.string().min(1).optional(),
    accountId: z.string().optional(),
    chatId: z.string().min(1).optional(),
    sender: z.string().min(1).optional(),
  })
  .strict();

const SessionRelayRoutingRuleSchema = z
  .object({
    mode: SessionRelayRoutingModeSchema,
    relayTo: z.string().min(1).optional(),
    match: SessionRelayRoutingMatchSchema.optional(),
  })
  .strict();

export const SessionRelayRoutingSchema = z
  .object({
    defaultMode: SessionRelayRoutingModeSchema.optional(),
    targets: z.record(z.string(), SessionRelayRoutingTargetSchema).optional(),
    rules: z.array(SessionRelayRoutingRuleSchema).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const targets = val.targets ?? {};

    const normalizeChannel = (value: string | undefined): string =>
      value?.trim().toLowerCase() ?? "";
    const normalizeAccountId = (value: string | undefined): string =>
      value?.trim().toLowerCase() || "default";

    for (const [targetKey, target] of Object.entries(targets)) {
      if (!target.channel.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", targetKey, "channel"],
          message: "relay target channel must not be empty",
        });
      }
      if (!target.to.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", targetKey, "to"],
          message: "relay target destination must not be empty",
        });
      }
    }

    for (const [index, rule] of (val.rules ?? []).entries()) {
      if (rule.mode !== "read-only") {
        continue;
      }
      const relayTo = rule.relayTo?.trim();
      if (!relayTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "relayTo"],
          message: 'relayTo is required when mode is "read-only"',
        });
        continue;
      }
      if (!Object.hasOwn(targets, relayTo)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "relayTo"],
          message: `relayTo "${relayTo}" must reference an existing targets key`,
        });
        continue;
      }

      const target = targets[relayTo];
      const sourceChannel = normalizeChannel(rule.match?.channel);
      const sourceChatId = rule.match?.chatId?.trim() ?? "";
      if (!sourceChannel || !sourceChatId) {
        continue;
      }
      const targetChannel = normalizeChannel(target.channel);
      const targetTo = target.to.trim();
      if (!targetChannel || !targetTo) {
        continue;
      }
      const sourceAccountId = normalizeAccountId(rule.match?.accountId);
      const targetAccountId = normalizeAccountId(target.accountId);
      // NOTE: This comparison uses raw strings — if one side is a configured
      // alias and the other is the canonical ID for the same destination, the
      // self-reference is not detected at validation time. The runtime policy
      // engine resolves both sides canonically so this is not a security gap,
      // but operators using aliases should expand them manually in config.
      if (
        sourceChannel === targetChannel &&
        sourceChatId === targetTo &&
        sourceAccountId === targetAccountId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "relayTo"],
          message:
            `relay target "${relayTo}" cannot be the same as protected source ` +
            `${sourceChannel}:${sourceChatId} (account: ${sourceAccountId})`,
        });
      }
    }
  });

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
    typingMode: TypingModeSchema.optional(),
    parentForkMaxTokens: z.number().int().nonnegative().optional(),
    mainKey: z.string().optional(),
    sendPolicy: SessionSendPolicySchema.optional(),
    relayRouting: SessionRelayRoutingSchema.optional(),
    agentToAgent: z
      .object({
        maxPingPongTurns: z.number().int().min(0).max(5).optional(),
      })
      .strict()
      .optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
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
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    removeAckAfterReply: z.boolean().optional(),
    statusReactions: z
      .object({
        enabled: z.boolean().optional(),
        emojis: z
          .object({
            thinking: z.string().optional(),
            tool: z.string().optional(),
            coding: z.string().optional(),
            web: z.string().optional(),
            done: z.string().optional(),
            error: z.string().optional(),
            stallSoft: z.string().optional(),
            stallHard: z.string().optional(),
          })
          .strict()
          .optional(),
        timing: z
          .object({
            debounceMs: z.number().int().min(0).optional(),
            stallSoftMs: z.number().int().min(0).optional(),
            stallHardMs: z.number().int().min(0).optional(),
            doneHoldMs: z.number().int().min(0).optional(),
            errorHoldMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    suppressToolErrors: z.boolean().optional(),
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
    restart: z.boolean().optional().default(true),
    useAccessGroups: z.boolean().optional(),
    ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    ownerDisplay: z.enum(["raw", "hash"]).optional().default("raw"),
    ownerDisplaySecret: z.string().optional().register(sensitive),
    allowFrom: ElevatedAllowFromSchema.optional(),
  })
  .strict()
  .optional()
  .default(
    () => ({ native: "auto", nativeSkills: "auto", restart: true, ownerDisplay: "raw" }) as const,
  );
