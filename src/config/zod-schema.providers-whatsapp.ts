import { z } from "zod";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import {
  BlockStreamingCoalesceSchema,
  ConfirmingConfigSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "./zod-schema.core.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const WhatsAppPairingConfigSchema = z
  .object({
    /** Notify the owner when a new pairing request is received. Default: false. */
    notifyOwner: z.boolean().optional().default(false),
    /** Chat JID to send pairing notifications to (e.g., "554788703000@s.whatsapp.net"). */
    ownerChat: z.string().optional(),
    /** Include the original message content in the notification. Default: true. */
    includeMessage: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.notifyOwner && !value.ownerChat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownerChat"],
        message: "ownerChat is required when notifyOwner is true",
      });
    }
  });

export const WhatsAppAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
    authDir: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    pairing: WhatsAppPairingConfigSchema.optional(),
    confirming: ConfirmingConfigSchema.optional(),
    selfChatMode: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
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
    // Validate dmPolicy="open" requires allowFrom to include "*"
    if (value.dmPolicy === "open") {
      const allow = (value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
      if (!allow.includes("*")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowFrom"],
          message: 'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
        });
      }
    }
    // Validate dmPolicy="confirming" requires confirming.ownerChat
    if (value.dmPolicy === "confirming" && !value.confirming?.ownerChat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirming", "ownerChat"],
        message: 'dmPolicy="confirming" requires confirming.ownerChat to be set',
      });
    }
  });

export const WhatsAppConfigSchema = z
  .object({
    accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    pairing: WhatsAppPairingConfigSchema.optional(),
    confirming: ConfirmingConfigSchema.optional(),
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    selfChatMode: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional().default(50),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        polls: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
    // Validate dmPolicy="open" requires allowFrom to include "*"
    if (value.dmPolicy === "open") {
      const allow = (value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
      if (!allow.includes("*")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowFrom"],
          message:
            'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
        });
      }
    }
    // Validate dmPolicy="confirming" requires confirming.ownerChat
    if (value.dmPolicy === "confirming" && !value.confirming?.ownerChat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirming", "ownerChat"],
        message: 'dmPolicy="confirming" requires confirming.ownerChat to be set',
      });
    }
  });
