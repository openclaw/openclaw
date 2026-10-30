import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { bindBeforeToolCallMetadata } from "../agents/before-tool-call-metadata.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { WorkerConnection } from "./worker-connection.js";

export function createWorkerGatewayToolProxies(
  surface: WorkerToolSurface,
  client: Pick<WorkerConnection, "invokeGatewayTool" | "cancelGatewayTool">,
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  for (const entry of surface.tools) {
    if (entry.execution !== "gateway") {
      continue;
    }
    const tool: AnyAgentTool = {
      ...entry.definition,
      execute: async (toolCallId, args, signal, onUpdate) => {
        signal?.throwIfAborted();
        if (!isRecord(args)) {
          throw new Error("Gateway tool arguments must be an object.");
        }
        const seconds = entry.timeout?.argument ? args[entry.timeout.argument] : undefined;
        const timeoutMs = entry.timeout
          ? Math.max(
              entry.timeout.minimumMs ?? 0,
              (typeof seconds === "number" ? seconds : (entry.timeout.defaultSeconds ?? 0)) *
                1_000 +
                (entry.timeout.paddingMs ?? 0),
            )
          : undefined;
        const invocation = { generation: surface.generation, toolCallId };
        const cancel = () => {
          void client.cancelGatewayTool(invocation).catch(() => {});
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          const response = await client.invokeGatewayTool(
            { ...invocation, toolId: entry.id, arguments: args },
            {
              replay: entry.replay,
              timeoutMs,
              signal,
              onUpdate: onUpdate
                ? (result) => onUpdate({ ...result, details: result.details })
                : undefined,
            },
          );
          signal?.throwIfAborted();
          if (!response.ok) {
            throw new Error(response.error.message);
          }
          return { ...response.payload, details: response.payload.details };
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    };
    if (entry.plugin) {
      setPluginToolMeta(tool, entry.plugin);
    }
    // The retained Gateway implementation owns before/after hooks for this call.
    bindBeforeToolCallMetadata(tool, {
      sourceTool: { ...tool },
      options: { emitDiagnostics: false },
    });
    tools.push(tool);
  }
  return tools;
}
