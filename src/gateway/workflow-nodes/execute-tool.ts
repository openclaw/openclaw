/**
 * Execute Tool Node Handler
 *
 * Executes a tool from the catalog
 */

import { listCoreToolSections, resolveCoreToolProfiles } from "../../agents/tool-catalog.js";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";

export const executeToolHandler: WorkflowNodeHandler = {
  actionType: "execute-tool",

  async execute(input: NodeInput, _context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      const toolName = config.toolName;
      const toolArgs = config.toolArgs;

      if (!toolName) {
        return {
          status: "error",
          error: "Execute Tool node missing toolName configuration",
          metadata: { nodeId, label },
        };
      }

      // Get available core tools
      const coreTools = listCoreToolSections().flatMap((section) =>
        section.tools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          description: tool.description,
          source: "core" as const,
          defaultProfiles: resolveCoreToolProfiles(tool.id),
        })),
      );

      const toolExists = coreTools.some((t) => t.id === toolName);

      if (!toolExists) {
        return {
          status: "error",
          error: `Tool "${toolName}" not found in catalog`,
          metadata: {
            nodeId,
            label,
            toolName,
            availableTools: coreTools.map((t) => t.id),
          },
        };
      }

      // For now, return a placeholder response
      // TODO: Implement actual tool execution via Pi agent or direct invocation
      return {
        status: "success",
        output: `Tool "${toolName}" executed with args: ${JSON.stringify(toolArgs || {})}`,
        metadata: {
          nodeId,
          label,
          toolName,
          toolArgs,
          executed: true,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "execute-tool",
        },
      };
    }
  },
};
