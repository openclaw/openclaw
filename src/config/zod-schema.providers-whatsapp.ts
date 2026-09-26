// Defines WhatsApp provider schema fragments for config parsing.
import { z } from "zod";
import { buildGroupEntrySchema } from "../channels/plugins/config-schema.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import {
  ChannelSendReadReceiptsSchema,
  buildChannelReactionShape,
  buildChannelAccountSchemaParts,
} from "./zod-schema.channel-messaging-common.js";
import {
  ChannelDeliveryStreamingConfigSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";

const WhatsAppGroupEntrySchema = buildGroupEntrySchema(undefined, {
  omit: ["skills", "enabled", "allowFrom"],
}).optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppDirectEntrySchema = z
  .object({
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

const WhatsAppDirectSchema = z.record(z.string(), WhatsAppDirectEntrySchema).optional();

const WhatsAppPluginHooksSchema = z
  .object({
    messageReceived: z.boolean().optional(),
  })
  .strict()
  .optional();

const { accountShape, rootPolicyShape } = buildChannelAccountSchemaParts({
  omit: ["name"],
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
  mediaMaxMb: z.number().int().positive().optional(),
});

const WhatsAppCommonShape = {
  ...accountShape,
  sendReadReceipts: ChannelSendReadReceiptsSchema,
  selfChatMode: z.boolean().optional(),
  groups: WhatsAppGroupsSchema,
  direct: WhatsAppDirectSchema,
  ...buildChannelReactionShape({
    reactionLevels: ["off", "ack", "minimal", "extensive"],
  }),
  pluginHooks: WhatsAppPluginHooksSchema,
};

const WhatsAppAccountSchema = z
  .object({
    ...WhatsAppCommonShape,
    name: z.string().optional(),
    /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
    authDir: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
  })
  .strict();

export const WhatsAppConfigSchema = z
  .object({
    ...WhatsAppCommonShape,
    ...rootPolicyShape,
    accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
    defaultAccount: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional().default(50),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        polls: z.boolean().optional(),
        calls: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const defaultAccount = resolveAccountEntry(value.accounts, "default");
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.whatsapp.dmPolicy="allowlist" requires channels.whatsapp.allowFrom to contain at least one sender ID',
    });
    if (!value.accounts) {
      return;
    }
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy =
        account.dmPolicy ??
        (accountId === "default" ? undefined : defaultAccount?.dmPolicy) ??
        value.dmPolicy;
      const effectiveAllowFrom =
        account.allowFrom ??
        (accountId === "default" ? undefined : defaultAccount?.allowFrom) ??
        value.allowFrom;
      requireOpenAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.whatsapp.accounts.*.dmPolicy="open" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to include "*"',
      });
      requireAllowlistAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.whatsapp.accounts.*.dmPolicy="allowlist" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to contain at least one sender ID',
      });
    }
  });
