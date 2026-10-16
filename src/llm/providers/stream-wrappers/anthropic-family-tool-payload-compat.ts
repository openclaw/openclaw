import { isOpenAIGpt56Model } from "@openclaw/ai/internal/openai";
import { projectRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
type AnthropicToolPayloadCompatibilityOptions = {
  toolSchemaMode?: "openai-functions";
  toolChoiceMode?: "openai-string-modes";
};

type OpenAiToolProjection = {
  readonly kind?: "custom" | "function";
  readonly name?: string;
  readonly projectedKind?: "custom" | "function";
  readonly tool: Record<string, unknown>;
};

type OpenAiFunctionToolsProjection = {
  readonly customFunctionNames: ReadonlySet<string>;
  readonly customNames: ReadonlySet<string>;
  readonly functionNames: ReadonlySet<string>;
  readonly tools: readonly Record<string, unknown>[];
};

function projectJsonObjectSchema(
  schema: unknown,
  path: string,
): Record<string, unknown> | undefined {
  const { schema: normalizedSchema, violations } = projectRuntimeToolInputSchema(schema, path);
  if (
    !isRecord(normalizedSchema) ||
    violations.some(
      (violation) => !violation.endsWith(".$dynamicRef") && !violation.endsWith(".$dynamicAnchor"),
    )
  ) {
    return undefined;
  }
  const { properties, required } = normalizedSchema;
  if (
    (properties !== undefined && properties !== null && !isRecord(properties)) ||
    (required !== undefined &&
      required !== null &&
      (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")))
  ) {
    return undefined;
  }
  if (properties === null) {
    delete normalizedSchema.properties;
  }
  if (required === null) {
    delete normalizedSchema.required;
  }
  return normalizedSchema;
}

function normalizeOpenAiFunctionAnthropicToolDefinition(
  tool: unknown,
): OpenAiToolProjection | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }

  const nested = isRecord(tool.function) ? tool.function : undefined;
  const rawName = normalizeOptionalString(tool.name);
  const custom =
    !nested && !rawName && tool.type === "custom" && isRecord(tool.custom)
      ? tool.custom
      : undefined;
  const definition = nested ?? custom ?? tool;
  const name = normalizeOptionalString(definition.name);
  if (!name) {
    return nested || custom ? undefined : { tool };
  }
  if (custom && custom.input_schema === undefined) {
    return { kind: "custom", name, projectedKind: "custom", tool };
  }
  let schema: unknown;
  let schemaField: "parameters" | "input_schema" = "parameters";
  if (nested) {
    schema = nested.parameters;
  } else if (custom || isRecord(definition.input_schema)) {
    schema = definition.input_schema;
    schemaField = "input_schema";
  } else {
    schema = definition.parameters;
    if (!isRecord(schema) && (definition.input_schema !== undefined || schema !== undefined)) {
      return undefined;
    }
    schema ??= { type: "object", properties: {} };
  }
  const parameters =
    schema === undefined ? undefined : projectJsonObjectSchema(schema, `${name}.${schemaField}`);
  if (schema !== undefined && !parameters) {
    return undefined;
  }
  const functionSpec: Record<string, unknown> = {
    name,
    ...(parameters ? { parameters } : {}),
  };
  const description = definition.description;
  if (typeof description === "string" && description.trim()) {
    functionSpec.description = description;
  }
  const strict = custom ? undefined : definition.strict;
  if (typeof strict === "boolean" || (nested && strict === null)) {
    functionSpec.strict = strict;
  }
  return {
    kind: custom ? "custom" : "function",
    name,
    projectedKind: "function",
    tool: {
      ...(nested ? tool : {}),
      type: "function",
      function: functionSpec,
    },
  };
}

function projectOpenAiFunctionAnthropicTools(
  tools: readonly unknown[],
): OpenAiFunctionToolsProjection {
  const projectedTools: Record<string, unknown>[] = [];
  const customFunctionNames = new Set<string>();
  const customNames = new Set<string>();
  const functionNames = new Set<string>();
  for (const tool of tools) {
    const projection = normalizeOpenAiFunctionAnthropicToolDefinition(tool);
    if (!projection) {
      continue;
    }
    projectedTools.push(projection.tool);
    if (projection.kind === "custom" && projection.name) {
      customNames.add(projection.name);
      if (projection.projectedKind === "function") {
        customFunctionNames.add(projection.name);
      }
    } else if (projection.kind === "function" && projection.name) {
      functionNames.add(projection.name);
    }
  }
  return {
    customFunctionNames,
    customNames,
    functionNames,
    tools: projectedTools,
  };
}

function isProjectedToolAvailable(
  projection: OpenAiFunctionToolsProjection | undefined,
  kind: "custom" | "function",
  name: string,
): boolean {
  return (
    !projection || (kind === "custom" ? projection.customNames : projection.functionNames).has(name)
  );
}

function projectToolChoiceKind(
  projection: OpenAiFunctionToolsProjection,
  kind: "custom" | "function",
  name: string,
): "custom" | "function" {
  return kind === "custom" && projection.customFunctionNames.has(name) ? "function" : kind;
}

function normalizeAllowedToolChoice(
  choice: Record<string, unknown>,
  toolProjection: OpenAiFunctionToolsProjection | undefined,
): unknown {
  if (!toolProjection || !isRecord(choice.allowed_tools)) {
    return choice;
  }
  const mode = choice.allowed_tools.mode;
  if ((mode !== "auto" && mode !== "required") || !Array.isArray(choice.allowed_tools.tools)) {
    return choice;
  }
  const tools = choice.allowed_tools.tools.flatMap<Record<string, unknown>>((tool) => {
    if (!isRecord(tool)) {
      return [];
    }
    const kind = tool.type === "custom" || tool.type === "function" ? tool.type : undefined;
    const definition = kind && isRecord(tool[kind]) ? tool[kind] : undefined;
    const name = definition && normalizeOptionalString(definition.name);
    if (!kind || !name || !isProjectedToolAvailable(toolProjection, kind, name)) {
      return [];
    }
    const projectedKind = projectToolChoiceKind(toolProjection, kind, name);
    return [{ type: projectedKind, [projectedKind]: { name } }];
  });
  if (tools.length === 0) {
    if (mode === "auto") {
      return "none";
    }
    throw new Error(
      "OpenAI-compatible Anthropic tool_choice requires a tool, but no allowed tools survived payload conversion",
    );
  }
  return {
    type: "allowed_tools",
    allowed_tools: { mode, tools },
  };
}

function normalizeOpenAiStringModeAnthropicToolChoice(
  toolChoice: unknown,
  toolProjection?: OpenAiFunctionToolsProjection,
): unknown {
  const mode = isRecord(toolChoice)
    ? toolChoice.type === "any"
      ? "required"
      : toolChoice.type
    : toolChoice;
  if (mode === "auto" || mode === "none" || mode === "required") {
    if (mode === "auto" && toolProjection?.tools.length === 0) {
      return undefined;
    }
    if (mode === "required" && toolProjection?.tools.length === 0) {
      throw new Error(
        "OpenAI-compatible Anthropic tool_choice requires a tool, but no tools survived payload conversion",
      );
    }
    return mode;
  }
  if (!isRecord(toolChoice)) {
    return toolChoice;
  }

  const choice = toolChoice;
  const kind = choice.type === "custom" ? "custom" : "function";
  const definition =
    choice.type === "tool" ? choice : choice.type === kind ? choice[kind] : undefined;
  const name = isRecord(definition) ? normalizeOptionalString(definition.name) : undefined;
  if (name) {
    if (!isProjectedToolAvailable(toolProjection, kind, name)) {
      throw new Error(
        `OpenAI-compatible Anthropic tool_choice requested unavailable tool "${name}" after payload conversion`,
      );
    }
    const projectedKind = toolProjection ? projectToolChoiceKind(toolProjection, kind, name) : kind;
    return { type: projectedKind, [projectedKind]: { name } };
  }
  if (choice.type === "allowed_tools") {
    return normalizeAllowedToolChoice(choice, toolProjection);
  }

  return toolChoice;
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  options?: AnthropicToolPayloadCompatibilityOptions,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, streamOptions) =>
    streamWithPayloadPatch(underlying, model, context, streamOptions, (payloadObj) => {
      if (model.api === "anthropic-messages") {
        const compatibilityFlag =
          isRecord(model.compat) && model.compat.requiresOpenAiAnthropicToolPayload === true;
        let toolProjection: OpenAiFunctionToolsProjection | undefined;
        if (
          Array.isArray(payloadObj.tools) &&
          (options?.toolSchemaMode === "openai-functions" || compatibilityFlag)
        ) {
          toolProjection = projectOpenAiFunctionAnthropicTools(payloadObj.tools);
          if (toolProjection.tools.length > 0) {
            payloadObj.tools = toolProjection.tools;
          } else {
            delete payloadObj.tools;
          }
        }
        if (options?.toolChoiceMode === "openai-string-modes" || compatibilityFlag) {
          const toolChoice = normalizeOpenAiStringModeAnthropicToolChoice(
            payloadObj.tool_choice,
            toolProjection,
          );
          if (toolChoice === undefined) {
            delete payloadObj.tool_choice;
          } else {
            payloadObj.tool_choice = toolChoice;
          }
        }
        if (
          isOpenAIGpt56Model(model) &&
          toolProjection?.tools.some((tool) => tool.type === "function")
        ) {
          // GPT-5.6 Chat Completions rejects function tools while reasoning
          // is enabled and defaults reasoning on when the field is omitted.
          payloadObj.reasoning_effort = "none";
        }
      }
    });
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createOpenAIAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn, {
    toolSchemaMode: "openai-functions",
    toolChoiceMode: "openai-string-modes",
  });
}
