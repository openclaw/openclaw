/** Wire metadata for OpenAI MCP Plugin Extensions; never a tool grant. */
import { z } from "zod";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";

const text = z.string().trim().min(1).max(2_048);
export const mcpAppIconSchema = z.object({
  src: text,
  mimeType: text.optional(),
  sizes: z.array(text).max(16).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});
const quickActionSchema = z.object({
  title: text,
  icons: z.array(mcpAppIconSchema).min(1).max(16),
  target: z.object({
    type: z.literal("tool"),
    name: text,
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
});
export const mcpAppEntrypointSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global"), quickAction: quickActionSchema.optional() }),
  z.object({ type: z.literal("thread") }),
  z.object({
    type: z.literal("file"),
    extensions: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\.[^\s/\\,]+$/),
      )
      .min(1)
      .max(64),
  }),
  z.object({ type: z.literal("settings"), searchTerms: z.array(text).max(64).optional() }),
]);
export const mcpAppSettingsCapabilitySchema = z.object({ readTool: text, updateTool: text });
const title = { title: text, description: z.string().max(8_192).optional() };
const settingSchema = z.discriminatedUnion("type", [
  z.object({ ...title, type: z.literal("boolean") }),
  z.object({
    ...title,
    type: z.literal("string"),
    enum: z.array(z.string()).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
  }),
  ...(["number", "integer"] as const).map((type) =>
    z.object({
      ...title,
      type: z.literal(type),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      multipleOf: z.number().positive().optional(),
    }),
  ),
]);
export const mcpAppSettingsSchema = z.object({
  schema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), settingSchema),
    required: z.array(text).optional(),
  }),
  values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  layout: z
    .array(
      z.object({
        kind: z.literal("group"),
        title: text,
        items: z.array(
          z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("property"), property: text }),
            z.object({ kind: z.literal("tool"), tool: text, ...title }),
          ]),
        ),
      }),
    )
    .optional(),
});

export type McpAppIcon = SchemaContract<z.infer<typeof mcpAppIconSchema>>;
type McpAppEntrypoint = SchemaContract<z.infer<typeof mcpAppEntrypointSchema>>;
export type McpAppToolExtensions = {
  entrypoints?: McpAppEntrypoint[];
  mentionSearch?: true;
  icons?: McpAppIcon[];
  preferredModelDisplayMode?: "inline" | "fullscreen";
};
export type McpAppSettingsCapability = z.infer<typeof mcpAppSettingsCapabilitySchema>;
export type McpAppSettings = SchemaContract<z.infer<typeof mcpAppSettingsSchema>>;
export type McpAppDiscoveredEntrypoint = {
  toolName: string;
  title: string;
  resourceUri: string;
  icons?: McpAppIcon[];
  entrypoint: McpAppEntrypoint;
};
export type McpAppDiscoveredServer = {
  serverName: string;
  /** Verified plugin attribution, absent for unowned configured servers. */
  pluginId?: string;
  marketplace?: string;
  label: string;
  icons?: McpAppIcon[];
  entrypoints: McpAppDiscoveredEntrypoint[];
  settings?: McpAppSettingsCapability;
  mentionTool?: string;
};
export type McpAppDiscoverResult = {
  servers: McpAppDiscoveredServer[];
  onboarding?: Array<{ pluginId: string; title: string }>;
};
export type McpAppExtensionTarget = { sessionKey: string; agentId?: string };
export type McpAppSettingsParams = McpAppExtensionTarget & {
  serverName: string;
  action: "read" | "update" | "tool";
  arguments?: { set: Record<string, string | number | boolean> };
  toolName?: string;
};
export type McpAppResourceLink = {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};
export type McpAppMentionResult = { resources: McpAppResourceLink[] };
