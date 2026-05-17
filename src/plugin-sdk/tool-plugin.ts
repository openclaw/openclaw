import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { jsonResult, textResult } from "../agents/tools/common.js";
import type { PluginManifestActivation } from "../plugins/manifest.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
} from "./plugin-entry.js";

const EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export const toolPluginMetadataSymbol = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");

export type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: AgentToolUpdateCallback<unknown>;
};

type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema
  ? Static<TConfigSchema>
  : Record<string, never>;

type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(
  definition: ToolPluginToolDefinition<TConfig, TParamsSchema>,
) => DefinedToolPluginTool;

export type ToolPluginToolDefinition<TConfig, TParamsSchema extends TSchema> = {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  execute: (
    params: Static<TParamsSchema>,
    config: TConfig,
    context: ToolPluginExecutionContext,
  ) => unknown;
};

type DefinedToolPluginTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
};

export type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
};

export type ToolPluginMetadata = {
  id: string;
  name: string;
  description: string;
  activation: PluginManifestActivation;
  configSchema: JsonSchemaObject;
  tools: ToolPluginStaticToolMetadata[];
};

export type DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> = {
  id: string;
  name: string;
  description: string;
  activation?: PluginManifestActivation;
  configSchema?: TConfigSchema;
  tools: (
    tool: ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>,
  ) => readonly DefinedToolPluginTool[];
};

export type DefinedToolPluginEntry = ReturnType<typeof definePluginEntry> & {
  [toolPluginMetadataSymbol]: ToolPluginMetadata;
};

function wrapToolPluginResult(result: unknown): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return textResult(result, result);
  }
  return jsonResult(result);
}

function createToolPluginToolFactory<TConfig>(): ToolPluginToolFactory<TConfig> {
  return ((definition: ToolPluginToolDefinition<TConfig, TSchema>) => ({
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: definition.execute as DefinedToolPluginTool["execute"],
  })) as ToolPluginToolFactory<TConfig>;
}

export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
  definition: DefineToolPluginOptions<TConfigSchema>,
): DefinedToolPluginEntry {
  const configSchema = (definition.configSchema ??
    EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA) as JsonSchemaObject;
  const pluginConfigSchema = buildJsonPluginConfigSchema(configSchema);
  const normalizedConfigSchema = pluginConfigSchema.jsonSchema ?? configSchema;
  const tools = [
    ...definition.tools(createToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>()),
  ];
  const activation = definition.activation ?? { onStartup: true };
  const metadata: ToolPluginMetadata = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    activation,
    configSchema: normalizedConfigSchema,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as JsonSchemaObject,
    })),
  };

  const entry = definePluginEntry({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: pluginConfigSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as ToolPluginConfig<TConfigSchema>;
      for (const tool of tools) {
        api.registerTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (toolCallId, params, signal, onUpdate) =>
            wrapToolPluginResult(
              await tool.execute(params, config, {
                api,
                signal,
                toolCallId,
                onUpdate,
              }),
            ),
        });
      }
    },
  }) as DefinedToolPluginEntry;

  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });
  return entry;
}

export function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const metadata = (entry as { [toolPluginMetadataSymbol]?: unknown })[toolPluginMetadataSymbol];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return metadata as ToolPluginMetadata;
}
