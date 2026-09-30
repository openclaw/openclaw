// Defines Google Chat provider schema fragments.
import { z } from "zod";
import { refineChannelDmPolicy } from "../channels/plugins/config-schema.js";
import {
  ChannelBotLoopProtectionSchema,
  ChannelDangerouslyAllowNameMatchingSchema,
  buildChannelAllowBotsSchema,
  buildChannelAccountSchemaParts,
} from "./zod-schema.channel-messaging-common.js";
import { ChannelDeliveryStreamingConfigSchema, SecretRefSchema } from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const GoogleChatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const GoogleChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const { accountShape, rootPolicyShape } = buildChannelAccountSchemaParts({
  omit: ["mentionPatterns"],
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
});

const GoogleChatAccountSchemaBase = z
  .object({
    ...accountShape,
    allowBots: buildChannelAllowBotsSchema(),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    requireMention: z.boolean().optional(),
    groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
    serviceAccount: z
      .union([z.string(), z.record(z.string(), z.unknown()), SecretRefSchema])
      .optional()
      .register(sensitive),
    serviceAccountFile: z.string().optional(),
    audienceType: z.enum(["app-url", "project-number"]).optional(),
    audience: z.string().optional(),
    appPrincipal: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
    botUser: z.string().optional(),
    dm: GoogleChatDmSchema.optional(),
    typingIndicator: z.enum(["none", "message", "reaction"]).optional(),
  })
  .strict();

export const GoogleChatConfigSchema = GoogleChatAccountSchemaBase.extend({
  ...rootPolicyShape,
  accounts: z.record(z.string(), GoogleChatAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  refineChannelDmPolicy({ channelId: "googlechat", value, ctx });
  for (const accountId of Object.keys(value.accounts ?? {})) {
    refineChannelDmPolicy({ channelId: "googlechat", value, accountId, ctx });
  }
});
