import type { VoiceClawSessionConfigEvent } from "./types.js";

type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type RealtimeTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const ECHO_TOOL: RealtimeTool = {
  type: "function",
  name: "echo_tool",
  description:
    "Test tool that echoes back whatever you send it. Use this when the user asks to test tools.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The message to echo back",
      },
    },
    required: ["message"],
  },
};

const ASK_BRAIN_TOOL: RealtimeTool = {
  type: "function",
  name: "ask_brain",
  description:
    "Ask your OpenClaw brain for memory, research, web access, calendar/tasks, file work, or any capability beyond basic conversation. Include URLs or relevant context in the query.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question or task to send to OpenClaw.",
      },
    },
    required: ["query"],
  },
};

export const VOICECLAW_SERVER_SIDE_TOOLS = new Set(["echo_tool", "ask_brain"]);

export function getGeminiTools(config: VoiceClawSessionConfigEvent): GeminiFunctionDeclaration[] {
  return getTools(config).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function handleSynchronousToolCall(name: string, args: string): string | null {
  switch (name) {
    case "echo_tool": {
      const parsed = parseToolArgs(args);
      return JSON.stringify({ echoed: typeof parsed.message === "string" ? parsed.message : "" });
    }
    case "ask_brain":
      return null;
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}

function getTools(config: VoiceClawSessionConfigEvent): RealtimeTool[] {
  const tools = [ECHO_TOOL];
  if (config.brainAgent !== "none") {
    tools.push(ASK_BRAIN_TOOL);
  }
  return tools;
}

function parseToolArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
