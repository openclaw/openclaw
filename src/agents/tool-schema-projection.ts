import { projectRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
/**
 * Projects agent tool schemas into JSON-safe runtime shapes and diagnostics.
 * Provider/runtime dispatch uses this module to drop incompatible tools before
 * sending schemas to model APIs.
 */
import type { AnyAgentTool } from "./tools/common.js";

export { projectRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
export type {
  RuntimeToolInputSchemaJson,
  RuntimeToolInputSchemaProjection,
} from "@openclaw/ai/internal/tool-schema";

export type RuntimeToolSchemaDiagnostic = {
  readonly toolName: string;
  readonly toolIndex: number;
  readonly violations: readonly string[];
};

/** Runtime tool list split into compatible tools and schema diagnostics. */
type RuntimeToolSchemaInspection<TTool extends Pick<AnyAgentTool, "name" | "parameters">> = {
  readonly tools: TTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

type ToolSchemaInspectionMode = "runtime" | "provider-normalizable";

const unreadableField = Symbol("unreadable tool field");

function readToolProjectionField(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  field: "name" | "parameters",
): unknown {
  try {
    return tool[field];
  } catch {
    return unreadableField;
  }
}

function inspectToolSchema(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  toolIndex: number,
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaDiagnostic | undefined {
  const nameRead = readToolProjectionField(tool, "name");
  const toolName = typeof nameRead === "string" && nameRead ? nameRead : `tool[${toolIndex}]`;
  const descriptorViolations =
    nameRead === unreadableField ? [`${toolName}.name is unreadable`] : undefined;
  const parametersRead = readToolProjectionField(tool, "parameters");
  if (parametersRead === unreadableField) {
    return {
      toolName,
      toolIndex,
      violations: [...(descriptorViolations ?? []), `${toolName}.parameters is unreadable`],
    };
  }
  if (mode === "provider-normalizable" && parametersRead === undefined) {
    return descriptorViolations
      ? { toolName, toolIndex, violations: descriptorViolations }
      : undefined;
  }

  const schemaPath = `${toolName}.parameters`;
  const projection = projectRuntimeToolInputSchema(parametersRead, schemaPath, toolName);
  const projectionViolations =
    mode === "runtime" || projection.violations.length === 0
      ? projection.violations
      : projection.violations.filter(
          (violation) =>
            !violation.endsWith(".$dynamicRef") && !violation.endsWith(".$dynamicAnchor"),
        );
  const violations = descriptorViolations
    ? [...descriptorViolations, ...projectionViolations]
    : projectionViolations;
  return violations.length > 0 ? { toolName, toolIndex, violations } : undefined;
}

function inspectToolEntries<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  entries: readonly (TTool | undefined)[],
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaInspection<TTool> {
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const compatibleTools: TTool[] = [];
  for (let toolIndex = 0; toolIndex < entries.length; toolIndex += 1) {
    let tool: TTool | undefined;
    try {
      tool = entries[toolIndex];
    } catch {
      tool = undefined;
    }
    if (tool === undefined) {
      diagnostics.push({
        toolName: `tool[${toolIndex}]`,
        toolIndex,
        violations: [`tool[${toolIndex}] is unreadable`],
      });
      continue;
    }
    const diagnostic = inspectToolSchema(tool, toolIndex, mode);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }
    compatibleTools.push(tool);
  }
  return { tools: compatibleTools, diagnostics };
}

/** Inspects runtime tool schemas and returns diagnostics without filtering tools. */
export function inspectRuntimeToolInputSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): RuntimeToolSchemaDiagnostic[] {
  return [...inspectToolEntries(tools, "runtime").diagnostics];
}

/** Filters tools to those with schemas accepted by the runtime as-is. */
export function filterRuntimeCompatibleTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(tools, "runtime");
}

/** Filters tools to those that providers can normalize before dispatch. */
export function filterProviderNormalizableTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(tools, "provider-normalizable");
}
