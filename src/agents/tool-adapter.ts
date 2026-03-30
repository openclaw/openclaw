// src/agents/tool-adapter.ts

import type { AnyAgentTool } from "../plugins/tools.js";

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: any;
  execute: (args: any) => Promise<any>;
}

/**
 * Adapts OpenClaw AgentTool -> LMStudio ToolDefinition
 * Minimal-invasive: nutzt bestehenden execute() Call
 */
export function adaptTool(tool: AnyAgentTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,

    async execute(args: any): Promise<any> {
      try {
        const result = await tool.execute(
          "toolcall",   // toolCallId (dummy)
          args,
          undefined,    // AbortSignal
          undefined     // onUpdate
        );

        // 🔑 WICHTIG: normalize output → verhindert Hallucinationen
        if (typeof result === "string") {
          return result;
        }

        if (result && typeof result === "object") {
          if ("content" in result && result.content) {
            return result.content;
          }

          if ("output" in result && result.output) {
            return result.output;
          }
        }

        // fallback (letzter Ausweg)
        return JSON.stringify(result, null, 2);

      } catch (err: any) {
        return `Tool execution failed: ${err?.message || err}`;
      }
    }
  };
}