// src/agents/tool-adapter.ts

// AnyAgentTool ist nicht mehr aus ../plugins/tools.js exportiert,
// daher lokal definieren, um die Abhängigkeit zu entkoppeln.
type AnyAgentTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (...args: unknown[]) => Promise<unknown>;
};

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
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

    async execute(args: Record<string, unknown>): Promise<unknown> {
      try {
        const result = await tool.execute(
          "toolcall", // toolCallId (dummy)
          args,
          undefined, // AbortSignal
          undefined, // onUpdate
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
      } catch (err: unknown) {
        return `Tool execution failed: ${(err as Error)?.message || String(err)}`;
      }
    },
  };
}
