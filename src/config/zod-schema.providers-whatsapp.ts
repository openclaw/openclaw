import { z } from "zod";
import { buildGroupEntrySchema, refineChannelDmPolicy } from "../channels/plugins/config-schema.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import {
  ChannelSendReadReceiptsSchema,
  buildChannelReactionShape,
  buildChannelAccountSchemaParts,
} from "./zod-schema.channel-messaging-common.js";
import { ChannelDeliveryStreamingConfigSchema } from "./zod-schema.core.js";

const WhatsAppGroupEntrySchema = buildGroupEntrySchema(undefined, {
  omit: ["skills", "enabled", "allowFrom"],
}).optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppDirectEntrySchema = z
  .strictObject({
    systemPrompt: z.string().optional(),
  })
  .optional();

const WhatsAppDirectSchema = z.record(z.string(), WhatsAppDirectEntrySchema).optional();

const WhatsAppPluginHooksSchema = z
  .strictObject({
    messageReceived: z.boolean().optional(),
  })
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

const WhatsAppAccountSchema = z.strictObject({
  ...WhatsAppCommonShape,
  name: z.string().optional(),
  /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
  authDir: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
});

export const WhatsAppConfigSchema = z
  .strictObject({
    ...WhatsAppCommonShape,
    ...rootPolicyShape,
    accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
    defaultAccount: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional().default(50),
    actions: z
      .strictObject({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        polls: z.boolean().optional(),
        calls: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const defaultAccount = resolveAccountEntry(value.accounts, "default");
    refineChannelDmPolicy({ channelId: "whatsapp", value, ctx });
    // Named accounts inherit the default account before the channel root.
    const inherited = {
      ...value,
      dmPolicy: defaultAccount?.dmPolicy ?? value.dmPolicy,
      allowFrom: defaultAccount?.allowFrom ?? value.allowFrom,
    };
    for (const accountId of Object.keys(value.accounts ?? {})) {
      refineChannelDmPolicy({
        channelId: "whatsapp",
        value: accountId === "default" ? value : inherited,
        accountId,
        ctx,
      });
    }
  });
