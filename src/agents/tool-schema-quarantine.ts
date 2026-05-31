import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  filterProviderNormalizableTools,
  type RuntimeToolSchemaDiagnostic,
  type RuntimeToolSchemaInspection,
} from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

const log = createSubsystemLogger("agents/tools");

function readToolAtIndex(
  tools: readonly AnyAgentTool[],
  toolIndex: number,
): AnyAgentTool | undefined {
  try {
    return tools[toolIndex];
  } catch {
    return undefined;
  }
}

function readToolPluginId(tool: AnyAgentTool | undefined): string | undefined {
  if (!tool) {
    return undefined;
  }
  try {
    return getPluginToolMeta(tool)?.pluginId;
  } catch {
    return undefined;
  }
}

export function filterRuntimeToolsWithReadableNames(
  tools: readonly AnyAgentTool[],
): AnyAgentTool[] {
  let length = 0;
  try {
    length = tools.length;
  } catch {
    return [];
  }
  const readableTools: AnyAgentTool[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const tool = tools[index];
      if (typeof tool.name === "string") {
        readableTools.push(tool);
      }
    } catch {
      continue;
    }
  }
  return readableTools;
}

export function hasReadableRuntimeToolName(tools: readonly AnyAgentTool[], name: string): boolean {
  let length = 0;
  try {
    length = tools.length;
  } catch {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    try {
      if (tools[index].name === name) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function collectReadableQuarantinedRuntimeToolNames(params: {
  tools: readonly AnyAgentTool[];
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const diagnostic of params.diagnostics) {
    if (
      seen.has(diagnostic.toolName) ||
      !hasReadableRuntimeToolName(params.tools, diagnostic.toolName)
    ) {
      continue;
    }
    seen.add(diagnostic.toolName);
    names.push(diagnostic.toolName);
  }
  return names;
}

export function inspectProviderNormalizableRuntimeTools(params: {
  tools: readonly AnyAgentTool[];
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): RuntimeToolSchemaInspection<AnyAgentTool> {
  const projection = filterProviderNormalizableTools(params.tools);
  logRuntimeToolSchemaQuarantine({
    diagnostics: projection.diagnostics,
    tools: params.tools,
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  return { tools: [...projection.tools], diagnostics: projection.diagnostics };
}

export function filterProviderNormalizableRuntimeTools(params: {
  tools: readonly AnyAgentTool[];
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): AnyAgentTool[] {
  return [...inspectProviderNormalizableRuntimeTools(params).tools];
}

export function logRuntimeToolSchemaQuarantine(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): void {
  if (params.diagnostics.length === 0) {
    return;
  }
  const summary = params.diagnostics
    .map((diagnostic) => {
      const pluginId = readToolPluginId(readToolAtIndex(params.tools, diagnostic.toolIndex));
      const owner = pluginId ? ` plugin=${pluginId}` : "";
      emitTrustedDiagnosticEvent({
        type: "tool.execution.blocked",
        runId: params.runId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        toolName: diagnostic.toolName,
        toolSource: pluginId ? "plugin" : "core",
        ...(pluginId ? { toolOwner: pluginId } : {}),
        deniedReason: "unsupported_tool_schema",
        reason: diagnostic.violations.join(", "),
      });
      return `${diagnostic.toolName}${owner}: ${diagnostic.violations.join(", ")}`;
    })
    .join("; ");
  log.warn(
    `[tools] quarantined ${params.diagnostics.length} unsupported tool schema${params.diagnostics.length === 1 ? "" : "s"} before model runtime projection: ${summary}. Run openclaw doctor for details.`,
  );
}
