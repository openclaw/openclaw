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

const WhatsAppGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict()
  .optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppAckReactionSchema = z
  .object({
    emoji: z.string().optional(),
    direct: z.boolean().optional().default(true),
    group: z.enum(["always", "mentions", "never"]).optional().default("mentions"),
  })
  .strict()
  .optional();

const WhatsAppSharedSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  markdown: MarkdownConfigSchema,
  configWrites: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  selfChatMode: z.boolean().optional(),
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  groups: WhatsAppGroupsSchema,
  ackReaction: WhatsAppAckReactionSchema,
  debounceMs: z.number().int().nonnegative().optional().default(0),
  heartbeat: ChannelHeartbeatVisibilitySchema,
});

function enforceOpenDmPolicyAllowFromStar(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
}) {
  if (params.dmPolicy !== "open") {
    return;
  }
  const allow = (Array.isArray(params.allowFrom) ? params.allowFrom : [])
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["allowFrom"],
    message: params.message,
  });
}

export const WhatsAppAccountSchema = WhatsAppSharedSchema.extend({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
  authDir: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    enforceOpenDmPolicyAllowFromStar({
      dmPolicy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      message: 'channels.whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    });
  });

export const WhatsAppConfigSchema = WhatsAppSharedSchema.extend({
  accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
  mediaMaxMb: z.number().int().positive().optional().default(50),
  actions: z
    .object({
      reactions: z.boolean().optional(),
      sendMessage: z.boolean().optional(),
      polls: z.boolean().optional(),
    })
    .strict()
    .optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    enforceOpenDmPolicyAllowFromStar({
      dmPolicy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    });
  });
