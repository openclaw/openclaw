import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../packages/agent-core/src/types.js";
import type {
  WorkerGatewayToolResult,
  WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { bindBeforeToolCallMetadata } from "../agents/before-tool-call-metadata.js";
import { setMcpCodeModeGuestResult } from "../agents/mcp-content.js";
import type { SkillInstructionResult } from "../agents/skill-instruction-result.js";
import { markToolExecutionRefused } from "../agents/tool-effect-receipt.js";
import { resolveToolResultBudget } from "../agents/tool-result-limits.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import { formatSkillInstructionsForModel } from "../agents/tools/installed-skill-tools.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { WorkerConnection } from "./worker-connection.js";

type WorkerSkillResources = {
  rewriteReferences: (text: string) => string;
  readInstructions: (
    name: string,
    location: string,
    signal?: AbortSignal,
  ) => Promise<SkillInstructionResult | undefined>;
};

async function projectSkillResult(
  name: string,
  payload: WorkerGatewayToolResult,
  surface: WorkerToolSurface,
  resources: WorkerSkillResources,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const result = { ...payload, details: payload.details };
  const details = result.details;
  if (result.isError || !isRecord(details)) {
    return result;
  }
  if (
    name === "skills_read" &&
    typeof details.name === "string" &&
    typeof details.location === "string" &&
    typeof details.content === "string"
  ) {
    if (typeof details.relativePath === "string") {
      return {
        ...result,
        details: { ...details, location: resources.rewriteReferences(details.location) },
      };
    }
    const instructions = await resources.readInstructions(details.name, details.location, signal);
    if (!instructions) {
      return result;
    }
    // The delivered copy owns both its location and any resource-omission notice.
    const { text } = formatSkillInstructionsForModel(
      instructions,
      resolveToolResultBudget(surface.policy.modelContextWindowTokens),
      surface.tools.some((entry) => entry.definition.name === "read"),
    );
    return { ...result, content: [{ type: "text", text }], details: instructions };
  }
  if (name === "skills_search" && Array.isArray(details.skills)) {
    return {
      ...result,
      ...jsonResult({
        ...details,
        skills: details.skills.map((skill: unknown) =>
          isRecord(skill) && typeof skill.location === "string"
            ? Object.assign({}, skill, { location: resources.rewriteReferences(skill.location) })
            : skill,
        ),
      }),
    };
  }
  return result;
}

export function createWorkerGatewayToolProxies(
  surface: WorkerToolSurface,
  client: Pick<WorkerConnection, "invokeGatewayTool" | "cancelGatewayTool">,
  skillResources?: WorkerSkillResources,
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
        let cancelRequested = false;
        const cancel = () => {
          if (cancelRequested) {
            return;
          }
          cancelRequested = true;
          void client.cancelGatewayTool(invocation).catch(() => {});
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          const response = await client
            .invokeGatewayTool(
              { ...invocation, toolId: entry.id, arguments: args },
              {
                replay: entry.replay,
                timeoutMs,
                signal,
                onUpdate: onUpdate
                  ? (result) => onUpdate({ ...result, details: result.details })
                  : undefined,
              },
            )
            .catch((error: unknown) => {
              // A lost response abandons this observer, not the Gateway's live call.
              cancel();
              throw error;
            });
          signal?.throwIfAborted();
          if (!response.ok) {
            throw new Error(response.error.message);
          }
          const { mcpGuestResult, mcpBlockedReason, ...payload } = response.payload;
          if (!entry.plugin?.mcp) {
            return skillResources
              ? projectSkillResult(entry.definition.name, payload, surface, skillResources, signal)
              : { ...payload, details: payload.details };
          }
          const result = { ...payload, details: payload.details };
          if (mcpBlockedReason !== undefined) {
            return markToolExecutionRefused(result, { kind: "blocked", reason: mcpBlockedReason });
          }
          return mcpGuestResult !== undefined
            ? setMcpCodeModeGuestResult(result, mcpGuestResult)
            : result;
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
