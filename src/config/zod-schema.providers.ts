import { z } from "zod";
import { getBundledChannelRuntimeMap } from "./bundled-channel-config-runtime.js";
import type { ChannelsConfig } from "./types.channels.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import { GroupPolicySchema } from "./zod-schema.core.js";
import {
  BlueBubblesConfigSchema,
  DiscordConfigSchema,
  GoogleChatConfigSchema,
  IMessageConfigSchema,
  MSTeamsConfigSchema,
  SignalConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
} from "./zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

export * from "./zod-schema.providers-core.js";
export * from "./zod-schema.providers-whatsapp.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

const ChannelModelByChannelSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .optional();

const directChannelRuntimeSchemas = new Map<
  string,
  { safeParse: (value: unknown) => ReturnType<z.ZodTypeAny["safeParse"]> }
>([
  ["bluebubbles", { safeParse: (value) => BlueBubblesConfigSchema.safeParse(value) }],
  ["discord", { safeParse: (value) => DiscordConfigSchema.safeParse(value) }],
  ["googlechat", { safeParse: (value) => GoogleChatConfigSchema.safeParse(value) }],
  ["imessage", { safeParse: (value) => IMessageConfigSchema.safeParse(value) }],
  ["msteams", { safeParse: (value) => MSTeamsConfigSchema.safeParse(value) }],
  ["signal", { safeParse: (value) => SignalConfigSchema.safeParse(value) }],
  ["slack", { safeParse: (value) => SlackConfigSchema.safeParse(value) }],
  ["telegram", { safeParse: (value) => TelegramConfigSchema.safeParse(value) }],
  ["whatsapp", { safeParse: (value) => WhatsAppConfigSchema.safeParse(value) }],
]);

function addLegacyChannelAcpBindingIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => addLegacyChannelAcpBindingIssues(entry, ctx, [...path, index]));
    return;
  }

  const record = value as Record<string, unknown>;
  const bindings = record.bindings;
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const acp = (bindings as Record<string, unknown>).acp;
    if (acp && typeof acp === "object") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "bindings", "acp"],
        message:
          "Legacy channel-local ACP bindings were removed; use top-level bindings[] entries.",
      });
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    addLegacyChannelAcpBindingIssues(entry, ctx, [...path, key]);
  }
}

function normalizeBundledChannelConfigs(
  value: ChannelsConfig | undefined,
  ctx: z.RefinementCtx,
): ChannelsConfig | undefined {
  if (!value) {
    return value;
  }

  let next: ChannelsConfig | undefined;
  for (const [channelId, runtimeSchema] of directChannelRuntimeSchemas) {
    if (!Object.prototype.hasOwnProperty.call(value, channelId)) {
      continue;
    }
    const parsed = runtimeSchema.safeParse(value[channelId]);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message ?? `Invalid channels.${channelId} config.`,
          path: [channelId, ...(Array.isArray(issue.path) ? issue.path : [])],
        });
      }
      continue;
    }
    next ??= { ...value };
    next[channelId] = parsed.data as ChannelsConfig[string];
  }

  for (const [channelId, runtimeSchema] of getBundledChannelRuntimeMap()) {
    if (!Object.prototype.hasOwnProperty.call(value, channelId)) {
      continue;
    }
    const parsed = runtimeSchema.safeParse(value[channelId]);
    if (!parsed.success) {
      for (const issue of parsed.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message ?? `Invalid channels.${channelId} config.`,
          path: [channelId, ...(Array.isArray(issue.path) ? issue.path : [])],
        });
      }
      continue;
    }
    next ??= { ...value };
    next[channelId] = parsed.data as ChannelsConfig[string];
  }

  return next ?? value;
}

export const ChannelsSchema: z.ZodType<ChannelsConfig | undefined> = z
  .object({
    defaults: z
      .object({
        groupPolicy: GroupPolicySchema.optional(),
        heartbeat: ChannelHeartbeatVisibilitySchema,
      })
      .strict()
      .optional(),
    modelByChannel: ChannelModelByChannelSchema,
  })
  .passthrough() // Allow extension channel configs (nostr, matrix, zalo, etc.)
  .superRefine((value, ctx) => {
    addLegacyChannelAcpBindingIssues(value, ctx);
  })
  .transform((value, ctx) => normalizeBundledChannelConfigs(value, ctx))
  .optional() as z.ZodType<ChannelsConfig | undefined>;
