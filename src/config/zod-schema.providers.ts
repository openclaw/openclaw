import { z } from "zod";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.plugin.js";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import type { ChannelsConfig } from "./types.channels.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import { ContextVisibilityModeSchema, GroupPolicySchema } from "./zod-schema.core.js";

export * from "./zod-schema.providers-core.js";
export * from "./zod-schema.providers-whatsapp.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

const ChannelModelByChannelSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .optional();

let directChannelRuntimeSchemasCache: ReadonlyMap<string, ChannelConfigRuntimeSchema> | undefined;

function getDirectChannelRuntimeSchemas(): ReadonlyMap<string, ChannelConfigRuntimeSchema> {
  if (!directChannelRuntimeSchemasCache) {
    const runtimeMap = new Map<string, ChannelConfigRuntimeSchema>();
    for (const entry of listBundledPluginMetadata({
      includeChannelConfigs: true,
      includeSyntheticChannelConfigs: true,
    })) {
      const channelConfigs = entry.manifest.channelConfigs;
      if (!channelConfigs) {
        continue;
      }
      for (const [channelId, channelConfig] of Object.entries(channelConfigs)) {
        if (channelConfig?.runtime && !runtimeMap.has(channelId)) {
          runtimeMap.set(channelId, channelConfig.runtime);
        }
      }
    }
    directChannelRuntimeSchemasCache = runtimeMap;
  }
  return directChannelRuntimeSchemasCache;
}

function hasPluginOwnedChannelConfig(
  value: ChannelsConfig,
): value is ChannelsConfig & Record<string, unknown> {
  return Object.keys(value).some((key) => key !== "defaults" && key !== "modelByChannel");
}

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
  if (!value || !hasPluginOwnedChannelConfig(value)) {
    return value;
  }

  let next: ChannelsConfig | undefined;
  for (const [channelId, runtimeSchema] of getDirectChannelRuntimeSchemas()) {
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
        contextVisibility: ContextVisibilityModeSchema.optional(),
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
