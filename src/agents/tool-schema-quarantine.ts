/**
 * Runtime tool-schema quarantine logging.
 *
 * Model providers can reject unsupported schema shapes, so runtime projection
 * reports quarantined tools with trusted diagnostics before the model call.
 */
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import {
  clearRecoveredPersistedRuntimeToolSchemaQuarantines,
  recordPersistedRuntimeToolSchemaQuarantine,
  type RuntimeToolSchemaQuarantineIdentity,
} from "./tool-schema-quarantine-health.js";
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

function pluginOwner(pluginId: string | undefined): string | undefined {
  return pluginId ? `plugin:${pluginId}` : undefined;
}

function toolQuarantineKey(params: RuntimeToolSchemaQuarantineIdentity): string {
  return JSON.stringify([params.owner ?? "", params.toolName]);
}

function readToolIdentity(tool: AnyAgentTool): RuntimeToolSchemaQuarantineIdentity | undefined {
  try {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      return undefined;
    }
    const owner = pluginOwner(getPluginToolMeta(tool)?.pluginId);
    return owner ? { owner, toolName: tool.name } : { toolName: tool.name };
  } catch {
    return undefined;
  }
}

// Tools that validated cleanly this run; identities behind a thunk so the
// common no-quarantine path does not even walk the tool list.
function listHealthyToolIdentities(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
}): RuntimeToolSchemaQuarantineIdentity[] {
  const failingKeys = new Set(
    params.diagnostics.map((diagnostic) =>
      toolQuarantineKey({
        owner: pluginOwner(readDiagnosticPluginId({ tools: params.tools, diagnostic })),
        toolName: diagnostic.toolName,
      }),
    ),
  );
  const healthy: RuntimeToolSchemaQuarantineIdentity[] = [];
  for (const tool of params.tools) {
    const identity = readToolIdentity(tool);
    if (identity && !failingKeys.has(toolQuarantineKey(identity))) {
      healthy.push(identity);
    }
  }
  return healthy;
}

/** Emits diagnostics and logs for tools removed from runtime schema projection. */
export async function logRuntimeToolSchemaQuarantine(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  runId: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  const recovered = clearRecoveredPersistedRuntimeToolSchemaQuarantines(() =>
    listHealthyToolIdentities({ diagnostics: params.diagnostics, tools: params.tools }),
  );
  const writes: Promise<void>[] = [];
  try {
    if (params.diagnostics.length === 0) {
      await recovered;
      return;
    }
    const summary = params.diagnostics
      .map((diagnostic) => {
        const pluginId = readDiagnosticPluginId({ tools: params.tools, diagnostic });
        const owner = pluginId ? ` plugin=${pluginId}` : "";
        // Emit structured evidence per quarantined tool; the warning below is
        // compact for operator logs.
        emitTrustedDiagnosticEvent({
          type: "tool.execution.blocked",
          runId: params.runId,
          agentId: params.agentId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          toolName: diagnostic.toolName,
          toolSource: pluginId ? "plugin" : "core",
          ...(pluginId ? { toolOwner: pluginId } : {}),
          deniedReason: "unsupported_tool_schema",
          reason: diagnostic.violations.join(", "),
        });
        const persistedOwner = pluginOwner(pluginId);
        writes.push(
          recordPersistedRuntimeToolSchemaQuarantine({
            toolName: diagnostic.toolName,
            ...(persistedOwner ? { owner: persistedOwner } : {}),
            reason: diagnostic.violations.join(", "),
            failedAt: new Date(),
          }).catch(() => {
            // Diagnostic event/log output still carries the failure if persistence is unavailable.
          }),
        );
        return `${diagnostic.toolName}${owner}: ${diagnostic.violations.join(", ")}`;
      })
      .join("; ");
    log.warn(
      `[tools] quarantined ${params.diagnostics.length} unsupported tool schema${params.diagnostics.length === 1 ? "" : "s"} before model runtime projection: ${summary}. Run openclaw doctor for details.`,
    );
    await recovered;
  } finally {
    await Promise.allSettled([recovered, ...writes]);
  }
}

export type RuntimeToolSchemaQuarantineRecorder = (
  params: Parameters<typeof logRuntimeToolSchemaQuarantine>[0],
) => void;

/** Joins diagnostic writes after a synchronous SDK or permission-publication callback finishes. */
export async function withRuntimeToolSchemaQuarantine<T>(
  run: (record: RuntimeToolSchemaQuarantineRecorder) => T | Promise<T>,
): Promise<T> {
  const pending: Promise<void>[] = [];
  const record: RuntimeToolSchemaQuarantineRecorder = (params) => {
    pending.push(logRuntimeToolSchemaQuarantine(params));
  };
  let result: T;
  try {
    result = await run(record);
  } catch (error) {
    await Promise.allSettled(pending);
    throw error;
  }
  const settled = await Promise.allSettled(pending);
  for (const operation of settled) {
    if (operation.status === "rejected") {
      throw operation.reason;
    }
  }
  return result;
}
