/**
 * MCP (Model Context Protocol) Server for Research Assistant
 *
 * Exposes research chatbot functionality as MCP tools for Claude integration.
 * Enables Claude to manage research documents, create sessions, and refine content.
 *
 * Note: This is a JSON-RPC based implementation compatible with MCP protocol.
 * The @modelcontextprotocol SDK can be added as an optional peer dependency.
 *
 * Usage:
 *   node dist/lib/research-mcp-server.js
 *
 * Claude integration (via mcporter or direct MCP support):
 *   - Call `research_create_session` with title/summary/template
 *   - Call `research_add_message` with sessionId and user content
 *   - Call `research_show_document` to preview
 *   - Call `research_export` to finalize
 */

import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
} from "node:process";
import * as readline from "node:readline";
import {
  addChatTurn,
  applyResearchSuggestions,
  createResearchChatSession,
  exportResearchDoc,
  formatResearchDocForChat,
  type ResearchChatSession,
} from "./research-chatbot.js";
import { generateOllamaResearchResponse } from "./research-ollama.js";

// In-memory session store (Phase 1; Phase 2 will use persistent storage)
const sessionStore = new Map<string, ResearchChatSession>();

/**
 * MCP Tool definitions (compatible with Model Context Protocol)
 */
export const RESEARCH_TOOLS = [
  {
    name: "research_create_session",
    description: "Create a new research chatbot session with initial title and optional summary",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Research title or topic" },
        summary: { type: "string", description: "One-line summary (optional)" },
        template: {
          type: "string",
          enum: ["brief", "design", "postmortem"],
          description: "Template to use (optional)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "research_add_message",
    description: "Add a user message to the session and get assistant response",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID from create_session" },
        content: { type: "string", description: "User message or notes" },
      },
      required: ["sessionId", "content"],
    },
  },
  {
    name: "research_show_document",
    description: "Display the current research document in Markdown format",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "research_export",
    description: "Export research document in Markdown or JSON format",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Export format",
        },
      },
      required: ["sessionId", "format"],
    },
  },
  {
    name: "research_list_sessions",
    description: "List all active research sessions",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "research_apply_suggestion",
    description: "Apply suggested changes to the research document",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        suggestion: { type: "string", description: "Assistant-generated suggestion with changes" },
      },
      required: ["sessionId", "suggestion"],
    },
  },
];

/**
 * Handle tool calls from Claude
 */
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "research_create_session": {
      const title = typeof args.title === "string" ? args.title : "Untitled";
      const summary = typeof args.summary === "string" ? args.summary : undefined;
      const template = typeof args.template === "string" ? args.template : undefined;

      const session = createResearchChatSession({
        title,
        summary,
        template: template as "brief" | "design" | "postmortem" | undefined,
      });

      sessionStore.set(session.sessionId, session);

      return JSON.stringify({
        ok: true,
        sessionId: session.sessionId,
        message: `Created session "${title}" (${session.sessionId})`,
      });
    }

    case "research_add_message": {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
      const content = typeof args.content === "string" ? args.content : "";

      const session = sessionStore.get(sessionId);
      if (!session) {
        return JSON.stringify({
          ok: false,
          error: `Session not found: ${sessionId}`,
        });
      }

      // Add user message
      let updated = addChatTurn(session, "user", content);

      // Generate assistant response using Ollama (Phase 2: LLM-powered)
      const assistantResponse = await generateOllamaResearchResponse(content, updated);

      // Add assistant response
      updated = addChatTurn(updated, "assistant", assistantResponse);

      // Apply suggestions if present
      updated = applyResearchSuggestions(updated, assistantResponse);

      // Update store
      sessionStore.set(sessionId, updated);

      return JSON.stringify({
        ok: true,
        sessionId,
        assistantResponse,
        turns: updated.turns.length,
        sections: updated.workingDoc.sections.length,
      });
    }

    case "research_show_document": {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";

      const session = sessionStore.get(sessionId);
      if (!session) {
        return JSON.stringify({
          ok: false,
          error: `Session not found: ${sessionId}`,
        });
      }

      const formatted = formatResearchDocForChat(session.workingDoc);

      return JSON.stringify({
        ok: true,
        sessionId,
        document: formatted,
        sectionCount: session.workingDoc.sections.length,
      });
    }

    case "research_export": {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
      const format = (args.format === "json" ? "json" : "markdown") as "markdown" | "json";

      const session = sessionStore.get(sessionId);
      if (!session) {
        return JSON.stringify({
          ok: false,
          error: `Session not found: ${sessionId}`,
        });
      }

      const exported = exportResearchDoc(session.workingDoc, format);

      return JSON.stringify({
        ok: true,
        sessionId,
        format,
        content: exported,
      });
    }

    case "research_list_sessions": {
      const sessions = Array.from(sessionStore.values()).map((s) => ({
        sessionId: s.sessionId,
        title: s.workingDoc.title,
        summary: s.workingDoc.summary,
        sections: s.workingDoc.sections.length,
        turns: s.turns.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));

      return JSON.stringify({
        ok: true,
        count: sessions.length,
        sessions,
      });
    }

    case "research_apply_suggestion": {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
      const suggestion = typeof args.suggestion === "string" ? args.suggestion : "";

      const session = sessionStore.get(sessionId);
      if (!session) {
        return JSON.stringify({
          ok: false,
          error: `Session not found: ${sessionId}`,
        });
      }

      const updated = applyResearchSuggestions(session, suggestion);
      sessionStore.set(sessionId, updated);

      return JSON.stringify({
        ok: true,
        sessionId,
        message: `Applied suggestion. Document now has ${updated.workingDoc.sections.length} sections.`,
      });
    }

    default:
      return JSON.stringify({
        ok: false,
        error: `Unknown tool: ${name}`,
      });
  }
}

/**
 * Create and start the MCP server (JSON-RPC over stdio)
 * Connects to local Ollama instance for LLM-powered research responses.
 */
export function startResearchMcpServer(): void {
  const rl = readline.createInterface({
    input: processStdin,
    output: processStdout,
    terminal: false,
  });

  processStderr.write("[research-mcp] Server starting on stdio\n");

  let _requestId = 0;

  rl.on("line", async (line) => {
    try {
      const message = JSON.parse(line);

      // Handle different MCP message types
      if (message.method === "tools/list") {
        // Return list of available tools
        const response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: RESEARCH_TOOLS,
          },
        };
        processStdout.write(JSON.stringify(response) + "\n");
      } else if (message.method === "tools/call") {
        // Call a specific tool
        const { name, arguments: toolArgs } = message.params;
        const result = await handleToolCall(name, toolArgs || {});

        const parsedResult = typeof result === "string" ? JSON.parse(result) : result;
        const response = {
          jsonrpc: "2.0",
          id: message.id,
          result: parsedResult,
        };
        processStdout.write(JSON.stringify(response) + "\n");
      } else if (message.method === "initialize") {
        // MCP initialization
        const response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "openclaw-research",
              version: "1.0.0",
            },
          },
        };
        processStdout.write(JSON.stringify(response) + "\n");
      } else {
        // Unknown method
        const response = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Unknown method: ${message.method}`,
          },
        };
        processStdout.write(JSON.stringify(response) + "\n");
      }
    } catch (error) {
      processStderr.write(`[research-mcp] Error: ${error}\n`);
    }
  });

  rl.on("close", () => {
    processStderr.write("[research-mcp] Connection closed\n");
    process.exit(0);
  });
}

// Auto-start if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  startResearchMcpServer();
}
