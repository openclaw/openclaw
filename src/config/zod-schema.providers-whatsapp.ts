import { z } from "zod";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "./zod-schema.core.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const WhatsAppActionsSchema = z
  .object({
    // Messaging
    reactions: z.boolean().optional(),
    sendMessage: z.boolean().optional(),
    polls: z.boolean().optional(),
    edit: z.boolean().optional(),
    unsend: z.boolean().optional(),
    reply: z.boolean().optional(),
    sticker: z.boolean().optional(),
    // Group management
    groupCreate: z.boolean().optional(),
    renameGroup: z.boolean().optional(),
    setGroupDescription: z.boolean().optional(),
    setGroupIcon: z.boolean().optional(),
    addParticipant: z.boolean().optional(),
    removeParticipant: z.boolean().optional(),
    promoteParticipant: z.boolean().optional(),
    demoteParticipant: z.boolean().optional(),
    leaveGroup: z.boolean().optional(),
    getInviteCode: z.boolean().optional(),
    revokeInviteCode: z.boolean().optional(),
    groupMetadata: z.boolean().optional(),
  })
  .strict()
  .optional();

export const WhatsAppAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    messagePrefix: z.string().optional(),
    /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
    authDir: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    selfChatMode: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    triggerPrefix: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    /** Request full history sync from WhatsApp on connect (OPT-IN, default false).
     * Warning: This can download thousands of messages and consume significant memory. */
    syncFullHistory: z.boolean().optional().default(false),
    actions: WhatsAppActionsSchema,
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            tools: ToolPolicySchema,
            toolsBySender: ToolPolicyBySenderSchema,
          })
          .strict()
          .optional(),
      )
      .optional(),
    ackReaction: z
      .object({
        emoji: z.string().optional(),
        direct: z.boolean().optional().default(true),
        group: z.enum(["always", "mentions", "never"]).optional().default("mentions"),
      })
      .strict()
      .optional(),
    debounceMs: z.number().int().nonnegative().optional().default(0),
    heartbeat: ChannelHeartbeatVisibilitySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dmPolicy !== "open") {
      return;
    }
    const allow = (value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
    if (allow.includes("*")) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowFrom"],
      message: 'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    });
  });

export const WhatsAppConfigSchema = z
  .object({
    accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    messagePrefix: z.string().optional(),
    selfChatMode: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    triggerPrefix: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional().default(50),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    /** Request full history sync from WhatsApp on connect (OPT-IN, default false).
     * Warning: This can download thousands of messages and consume significant memory. */
    syncFullHistory: z.boolean().optional().default(false),
    actions: WhatsAppActionsSchema,
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            tools: ToolPolicySchema,
            toolsBySender: ToolPolicyBySenderSchema,
          })
          .strict()
          .optional(),
      )
      .optional(),
    ackReaction: z
      .object({
        emoji: z.string().optional(),
        direct: z.boolean().optional().default(true),
        group: z.enum(["always", "mentions", "never"]).optional().default("mentions"),
      })
      .strict()
      .optional(),
    debounceMs: z.number().int().nonnegative().optional().default(0),
    heartbeat: ChannelHeartbeatVisibilitySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dmPolicy !== "open") {
      return;
    }
    const allow = (value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
    if (allow.includes("*")) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowFrom"],
      message:
        'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    });
  });
