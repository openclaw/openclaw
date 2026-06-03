import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

const log = createSubsystemLogger("agents/tools");

function readDiagnosticPluginId(params: {
  tools: readonly AnyAgentTool[];
  diagnostic: RuntimeToolSchemaDiagnostic;
}): string | undefined {
  try {
    const tool = params.tools[params.diagnostic.toolIndex];
    return tool ? getPluginToolMeta(tool)?.pluginId : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeQuarantineDiagnosticText(value: string, fallback: string): string {
  const sanitized = sanitizeForLog(value);
  return sanitized.length > 0 ? sanitized : fallback;
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
      const pluginId = readDiagnosticPluginId({ tools: params.tools, diagnostic });
      const safeToolName = sanitizeQuarantineDiagnosticText(diagnostic.toolName, "unknown-tool");
      const safePluginId = pluginId
        ? sanitizeQuarantineDiagnosticText(pluginId, "unknown-plugin")
        : undefined;
      const reason = diagnostic.violations
        .map((violation) => sanitizeQuarantineDiagnosticText(violation, "unsupported schema"))
        .join(", ");
      const owner = safePluginId ? ` plugin=${safePluginId}` : "";
      emitTrustedDiagnosticEvent({
        type: "tool.execution.blocked",
        runId: params.runId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        toolName: safeToolName,
        toolSource: safePluginId ? "plugin" : "core",
        ...(safePluginId ? { toolOwner: safePluginId } : {}),
        deniedReason: "unsupported_tool_schema",
        reason,
      });
      return `${safeToolName}${owner}: ${reason}`;
    })
    .join("; ");
  log.warn(
    `[tools] quarantined ${params.diagnostics.length} unsupported tool schema${params.diagnostics.length === 1 ? "" : "s"} before model runtime projection: ${summary}. Run openclaw doctor for details.`,
  );
}
