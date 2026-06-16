import { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";
/**
 * Projects agent tool schemas into JSON-safe runtime shapes and diagnostics.
 * Provider/runtime dispatch uses this module to drop incompatible tools before
 * sending schemas to model APIs.
 */
import type { AnyAgentTool } from "./tools/common.js";

export { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";
export type {
  RuntimeToolInputSchemaJson,
  RuntimeToolInputSchemaProjection,
} from "./tool-schema-json-projection.js";

/** Diagnostic for one incompatible runtime tool schema. */
export type RuntimeToolSchemaDiagnostic = {
  readonly toolName: string;
  readonly toolIndex: number;
  readonly violations: readonly string[];
};

/** Runtime tool list split into compatible tools and schema diagnostics. */
export type RuntimeToolSchemaInspection<TTool extends Pick<AnyAgentTool, "name" | "parameters">> = {
  readonly tools: readonly TTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

type RuntimeToolEntryRead<TTool extends Pick<AnyAgentTool, "name" | "parameters">> =
  | {
      readonly ok: true;
      readonly tool: TTool;
      readonly toolIndex: number;
    }
  | {
      readonly ok: false;
      readonly diagnostic: RuntimeToolSchemaDiagnostic;
    };

type ToolSchemaInspectionMode = "runtime" | "provider-normalizable";

function unreadableRuntimeToolEntry(
  toolIndex: number,
): RuntimeToolEntryRead<Pick<AnyAgentTool, "name" | "parameters">> {
  return {
    ok: false,
    diagnostic: {
      toolName: `tool[${toolIndex}]`,
      toolIndex,
      violations: [`tool[${toolIndex}] is unreadable`],
    },
  };
}

function readRuntimeToolEntries<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  tools: readonly TTool[],
): RuntimeToolEntryRead<TTool>[] {
  let length: number;
  try {
    length = tools.length;
  } catch {
    return [unreadableRuntimeToolEntry(0) as RuntimeToolEntryRead<TTool>];
  }
  const entries: RuntimeToolEntryRead<TTool>[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    try {
      entries.push({ ok: true, tool: tools[toolIndex], toolIndex });
    } catch {
      entries.push(unreadableRuntimeToolEntry(toolIndex) as RuntimeToolEntryRead<TTool>);
    }
  }
  return entries;
}

function readToolProjectionField<TField extends "name" | "parameters">(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  field: TField,
):
  | { readable: true; value: Pick<AnyAgentTool, "name" | "parameters">[TField] }
  | { readable: false } {
  try {
    return { readable: true, value: tool[field] };
  } catch {
    return { readable: false };
  }
}

function inspectToolSchema(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  toolIndex: number,
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaDiagnostic | undefined {
  const nameRead = readToolProjectionField(tool, "name");
  const toolName =
    nameRead.readable && typeof nameRead.value === "string" && nameRead.value
      ? nameRead.value
      : `tool[${toolIndex}]`;
  const descriptorViolations = nameRead.readable ? [] : [`${toolName}.name is unreadable`];
  const parametersRead = readToolProjectionField(tool, "parameters");
  if (!parametersRead.readable) {
    return {
      toolName,
      toolIndex,
      violations: [...descriptorViolations, `${toolName}.parameters is unreadable`],
    };
  }
  if (mode === "provider-normalizable" && parametersRead.value === undefined) {
    return descriptorViolations.length > 0
      ? { toolName, toolIndex, violations: descriptorViolations }
      : undefined;
  }

  const schemaPath = `${toolName}.parameters`;
  const projection = projectRuntimeToolInputSchema(parametersRead.value, schemaPath);
  const projectionViolations =
    mode === "runtime"
      ? projection.violations
      : projection.violations.filter(
          (violation) =>
            violation !== `${schemaPath}.$dynamicRef` &&
            violation !== `${schemaPath}.$dynamicAnchor` &&
            !violation.endsWith(".$dynamicRef") &&
            !violation.endsWith(".$dynamicAnchor"),
        );
  const violations = [...descriptorViolations, ...projectionViolations];
  return violations.length > 0 ? { toolName, toolIndex, violations } : undefined;
}

function inspectToolEntries<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  entries: readonly RuntimeToolEntryRead<TTool>[],
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaInspection<TTool> {
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const compatibleTools: TTool[] = [];
  for (const entry of entries) {
    if (!entry.ok) {
      diagnostics.push(entry.diagnostic);
      continue;
    }
    const diagnostic = inspectToolSchema(entry.tool, entry.toolIndex, mode);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }
    compatibleTools.push(entry.tool);
  }
  return { tools: compatibleTools, diagnostics };
}

/** Inspects runtime tool schemas and returns diagnostics without filtering tools. */
export function inspectRuntimeToolInputSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): RuntimeToolSchemaDiagnostic[] {
  return [...inspectToolEntries(readRuntimeToolEntries(tools), "runtime").diagnostics];
}

/** Filters tools to those with schemas accepted by the runtime as-is. */
export function filterRuntimeCompatibleTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(readRuntimeToolEntries(tools), "runtime");
}

/** Filters tools to those that providers can normalize before dispatch. */
export function filterProviderNormalizableTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(readRuntimeToolEntries(tools), "provider-normalizable");
}
