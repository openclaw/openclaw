import { Type, type Static, type TSchema } from "typebox";
import type {
  AgentToolResult,
  AgentToolTerminalResultFallback,
  AgentToolUpdateCallback,
} from "../agents/runtime/index.js";
import { jsonResult, textResult } from "../agents/tools/common.js";
import type { PluginManifestActivation } from "../plugins/manifest.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "./plugin-entry.js";

const EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });
const AGENT_TOOL_RESULT_MARK = Symbol.for("openclaw.agentToolResult");

export const toolPluginMetadataSymbol = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");

export type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: AgentToolUpdateCallback;
};

type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema
  ? Static<TConfigSchema>
  : Record<string, never>;

type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(
  definition: ToolPluginToolDefinition<TConfig, TParamsSchema>,
) => DefinedToolPluginTool;

export type ToolPluginFactoryContext<TConfig> = {
  api: OpenClawPluginApi;
  config: TConfig;
  toolContext: OpenClawPluginToolContext;
};

type ToolPluginToolDefinitionBase<TParamsSchema extends TSchema> = {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  optional?: boolean;
  /** Safe user-facing fallback for forced terminal replies after repeated tool-call loops. */
  terminalResultFallback?: AgentToolTerminalResultFallback;
};

export type ToolPluginToolDefinition<
  TConfig,
  TParamsSchema extends TSchema,
> = ToolPluginToolDefinitionBase<TParamsSchema> &
  (
    | {
        execute: (
          params: Static<TParamsSchema>,
          config: TConfig,
          context: ToolPluginExecutionContext,
        ) => unknown;
        factory?: never;
      }
    | {
        factory: (
          context: ToolPluginFactoryContext<TConfig>,
        ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
        execute?: never;
      }
  );

type DefinedToolPluginTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  optional: boolean;
  terminalResultFallback?: AgentToolTerminalResultFallback;
  execute?: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
  factory?: (
    context: ToolPluginFactoryContext<unknown>,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
};

export type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  optional?: boolean;
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

export function toolResult<TDetails>(
  result: AgentToolResult<TDetails>,
): AgentToolResult<TDetails> {
  Object.defineProperty(result, AGENT_TOOL_RESULT_MARK, { value: true });
  return result;
}

function wrapToolPluginResult(result: unknown): AgentToolResult<unknown> {
  if (isAgentToolResult(result)) {
    return result;
  }
  if (typeof result === "string") {
    return textResult(result, result);
  }
  return jsonResult(result);
}

function isAgentToolContentBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
  if (record.type === "text") {
    return typeof record.text === "string";
  }
  if (record.type === "image") {
    return typeof record.data === "string" && typeof record.mimeType === "string";
  }
  return false;
}

function isMarkedAgentToolResult(value: object): boolean {
  return (value as Record<typeof AGENT_TOOL_RESULT_MARK, unknown>)[AGENT_TOOL_RESULT_MARK] === true;
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!("details" in record) || !Array.isArray(record.content)) {
    return false;
  }
  if (!record.content.every(isAgentToolContentBlock)) {
    return false;
  }
  return (
    isMarkedAgentToolResult(value) ||
    "terminalSummary" in record ||
    "progress" in record ||
    "terminate" in record ||
    record.content.some((block) => (block as { type?: unknown }).type !== "text")
  );
}

function createToolPluginToolFactory<TConfig>(): ToolPluginToolFactory<TConfig> {
  return ((definition: ToolPluginToolDefinition<TConfig, TSchema>) => ({
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    optional: definition.optional === true,
    terminalResultFallback: definition.terminalResultFallback,
    execute: definition.execute as DefinedToolPluginTool["execute"],
    factory: definition.factory as DefinedToolPluginTool["factory"],
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
      ...(tool.optional ? { optional: true } : {}),
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
        const opts = {
          name: tool.name,
          ...(tool.optional ? { optional: true } : {}),
        };
        if (tool.factory) {
          api.registerTool(
            (toolContext) =>
              tool.factory?.({
                api,
                config,
                toolContext,
              }),
            opts,
          );
          continue;
        }
        const execute = tool.execute;
        if (!execute) {
          throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
        }
        api.registerTool(
          {
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            terminalResultFallback: tool.terminalResultFallback,
            execute: async (toolCallId, params, signal, onUpdate) =>
              wrapToolPluginResult(
                await execute(params, config, {
                  api,
                  signal,
                  toolCallId,
                  onUpdate,
                }),
              ),
          },
          tool.optional ? { optional: true } : undefined,
        );
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
