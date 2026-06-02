import { Type, type Static, type TSchema } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "../agents/runtime/index.js";
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
) => DefinedToolPluginValidTool;

type InternalToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(
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

type DefinedToolPluginValidTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  optional: boolean;
  execute?: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
  factory?: (
    context: ToolPluginFactoryContext<unknown>,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
};

type DefinedToolPluginMalformedTool = {
  name?: string;
  malformedReason: string;
};

type DefinedToolPluginTool = DefinedToolPluginValidTool | DefinedToolPluginMalformedTool;

export type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  optional?: boolean;
};

export type ToolPluginStaticToolDiagnostic = {
  toolName?: string;
  message: string;
};

export type ToolPluginMetadata = {
  id: string;
  name: string;
  description: string;
  activation: PluginManifestActivation;
  configSchema: JsonSchemaObject;
  tools: ToolPluginStaticToolMetadata[];
  diagnostics?: ToolPluginStaticToolDiagnostic[];
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

function isValidToolPluginTool(tool: DefinedToolPluginTool): tool is DefinedToolPluginValidTool {
  return !("malformedReason" in tool);
}

function isMalformedToolPluginTool(
  tool: DefinedToolPluginTool,
): tool is DefinedToolPluginMalformedTool {
  return "malformedReason" in tool;
}

function isObjectSchema(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ToolDefinitionRead = { ok: true; value: unknown } | { ok: false };

function readToolDefinitionValue(
  definition: ToolPluginToolDefinition<unknown, TSchema>,
  key: string,
): ToolDefinitionRead {
  try {
    return { ok: true, value: (definition as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function malformedTool(name: string | undefined, message: string): DefinedToolPluginMalformedTool {
  return name ? { name, malformedReason: message } : { malformedReason: message };
}

function staticToolDiagnostic(
  tool: DefinedToolPluginMalformedTool,
): ToolPluginStaticToolDiagnostic {
  return tool.name
    ? { toolName: tool.name, message: tool.malformedReason }
    : { message: tool.malformedReason };
}

function staticToolMetadata(tool: DefinedToolPluginValidTool): ToolPluginStaticToolMetadata {
  const metadata: ToolPluginStaticToolMetadata = {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as JsonSchemaObject,
  };
  if (tool.optional) {
    metadata.optional = true;
  }
  return metadata;
}

function malformedToolMessage(tool: DefinedToolPluginMalformedTool): string {
  return `tool plugin skipped malformed static tool${
    tool.name ? ` ${tool.name}` : ""
  }: ${tool.malformedReason}`;
}

function createToolPluginToolFactory<TConfig>(): InternalToolPluginToolFactory<TConfig> {
  return ((definition: ToolPluginToolDefinition<TConfig, TSchema>) => {
    const unknownDefinition = definition as ToolPluginToolDefinition<unknown, TSchema>;
    const rawName = readToolDefinitionValue(unknownDefinition, "name");
    const name = rawName.ok && typeof rawName.value === "string" ? rawName.value : "";
    if (!name.trim()) {
      return malformedTool(undefined, "tool name must be a non-empty string");
    }

    const description = readToolDefinitionValue(unknownDefinition, "description");
    if (!description.ok || typeof description.value !== "string") {
      return malformedTool(name, "description must be a string");
    }

    const parameters = readToolDefinitionValue(unknownDefinition, "parameters");
    if (!parameters.ok || !isObjectSchema(parameters.value)) {
      return malformedTool(name, "parameters must be a schema object");
    }

    const execute = readToolDefinitionValue(unknownDefinition, "execute");
    const factory = readToolDefinitionValue(unknownDefinition, "factory");
    if (!execute.ok || !factory.ok) {
      return malformedTool(name, "execute and factory metadata must be readable");
    }
    const hasExecute = typeof execute.value === "function";
    const hasFactory = typeof factory.value === "function";
    if (!hasExecute && !hasFactory) {
      return malformedTool(name, "execute or factory must be a function");
    }
    if (hasExecute && hasFactory) {
      return malformedTool(name, "define either execute or factory, not both");
    }

    const label = readToolDefinitionValue(unknownDefinition, "label");
    const optional = readToolDefinitionValue(unknownDefinition, "optional");
    if (!optional.ok) {
      return malformedTool(name, "optional metadata must be readable");
    }
    return {
      name,
      label: label.ok && typeof label.value === "string" && label.value ? label.value : name,
      description: description.value,
      parameters: parameters.value,
      optional: optional.value === true,
      ...(hasExecute
        ? { execute: execute.value as DefinedToolPluginValidTool["execute"] }
        : { factory: factory.value as DefinedToolPluginValidTool["factory"] }),
    };
  }) as InternalToolPluginToolFactory<TConfig>;
}

export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
  definition: DefineToolPluginOptions<TConfigSchema>,
): DefinedToolPluginEntry {
  const configSchema = (definition.configSchema ??
    EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA) as JsonSchemaObject;
  const pluginConfigSchema = buildJsonPluginConfigSchema(configSchema);
  const normalizedConfigSchema = pluginConfigSchema.jsonSchema ?? configSchema;
  const toolFactory = createToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>();
  const tools = [
    ...definition.tools(toolFactory as ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>),
  ] as DefinedToolPluginTool[];
  const validTools = tools.filter(isValidToolPluginTool);
  const diagnostics = tools.filter(isMalformedToolPluginTool).map(staticToolDiagnostic);
  const activation = definition.activation ?? { onStartup: true };
  const metadata: ToolPluginMetadata = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    activation,
    configSchema: normalizedConfigSchema,
    tools: validTools.map(staticToolMetadata),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };

  const entry = definePluginEntry({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: pluginConfigSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as ToolPluginConfig<TConfigSchema>;
      for (const tool of tools) {
        if (!isValidToolPluginTool(tool)) {
          api.logger.warn?.(malformedToolMessage(tool));
          continue;
        }
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
