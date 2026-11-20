import { readFile } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../packages/agent-core/src/types.js";
import type {
  WorkerGatewayToolResult,
  WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { bindBeforeToolCallMetadata } from "../agents/before-tool-call-metadata.js";
import { formatSkillInstructions } from "../agents/skill-instruction-result.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult, textResult } from "../agents/tools/tool-results.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { WorkerConnection } from "./worker-connection.js";

type ResolveSkillLocation = (name: string, location: string) => string | undefined;

async function projectSkillResult(
  toolName: string,
  result: WorkerGatewayToolResult & { details: unknown },
  resolveSkillLocation: ResolveSkillLocation,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const { details } = result;
  if (result.isError || !isRecord(details)) {
    return result;
  }
  if (
    toolName === "skills_read" &&
    typeof details.name === "string" &&
    typeof details.location === "string" &&
    typeof details.content === "string"
  ) {
    const location = resolveSkillLocation(details.name, details.location);
    if (location) {
      // The Gateway authorizes the read; only this turn's delivered copy supplies the bytes.
      const content = await readFile(location, { encoding: "utf8", signal });
      signal?.throwIfAborted();
      const instructions = { name: details.name, location, content };
      return { ...result, ...textResult(formatSkillInstructions(instructions), instructions) };
    }
  }
  if (toolName === "skills_search" && Array.isArray(details.skills)) {
    const skills = details.skills.map((skill: unknown) => {
      if (
        !isRecord(skill) ||
        typeof skill.name !== "string" ||
        typeof skill.location !== "string"
      ) {
        return skill;
      }
      const location = resolveSkillLocation(skill.name, skill.location);
      return location ? { ...skill, location } : skill;
    });
    return { ...result, ...jsonResult({ ...details, skills }) };
  }
  return result;
}

export function createWorkerGatewayToolProxies(
  surface: WorkerToolSurface,
  client: Pick<WorkerConnection, "invokeGatewayTool" | "cancelGatewayTool">,
  resolveSkillLocation?: ResolveSkillLocation,
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
          const result = { ...response.payload, details: response.payload.details };
          return resolveSkillLocation &&
            (entry.definition.name === "skills_read" || entry.definition.name === "skills_search")
            ? await projectSkillResult(entry.definition.name, result, resolveSkillLocation, signal)
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
