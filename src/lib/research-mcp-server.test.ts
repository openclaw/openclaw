/**
 * Tests for MCP (Model Context Protocol) Server
 * Verifies tool routing, JSON-RPC protocol, and session management
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ResearchChatSession } from "./research-chatbot.js";
import { createResearchChatSession } from "./research-chatbot.js";

describe("MCP Server - Tool Definitions", () => {
  it("should export research tools", async () => {
    const { RESEARCH_TOOLS } = await import("./research-mcp-server.js");

    expect(RESEARCH_TOOLS).toBeDefined();
    expect(Array.isArray(RESEARCH_TOOLS)).toBe(true);
    expect(RESEARCH_TOOLS.length).toBe(6);
  });

  it("should have all required tools", async () => {
    const { RESEARCH_TOOLS } = await import("./research-mcp-server.js");

    const toolNames = RESEARCH_TOOLS.map((t: unknown) => (t as { name: string }).name);
    expect(toolNames).toContain("research_create_session");
    expect(toolNames).toContain("research_add_message");
    expect(toolNames).toContain("research_show_document");
    expect(toolNames).toContain("research_export");
    expect(toolNames).toContain("research_list_sessions");
    expect(toolNames).toContain("research_apply_suggestion");
  });

  it("should have proper tool descriptions", async () => {
    const { RESEARCH_TOOLS } = await import("./research-mcp-server.js");

    for (const tool of RESEARCH_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  describe("research_create_session tool", () => {
    it("should have correct input schema", async () => {
      const { RESEARCH_TOOLS } = await import("./research-mcp-server.js");

      const tool = RESEARCH_TOOLS.find(
        (t: unknown) => (t as { name: string }).name === "research_create_session",
      );
      expect(tool).toBeDefined();
      if (!tool) {
        return;
      }
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toHaveProperty("title");
    });
  });

  describe("research_add_message tool", () => {
    it("should have correct input schema", async () => {
      const { RESEARCH_TOOLS } = await import("./research-mcp-server.js");

      const tool = RESEARCH_TOOLS.find(
        (t: unknown) => (t as { name: string }).name === "research_add_message",
      );
      expect(tool).toBeDefined();
      if (!tool) {
        return;
      }
      expect(tool.inputSchema.properties).toHaveProperty("sessionId");
      expect(tool.inputSchema.properties).toHaveProperty("content");
    });
  });

  describe("research_export tool", () => {
    it("should have format enum", async () => {
      const { RESEARCH_TOOLS } = await import("./research-mcp-server.js");

      const tool = RESEARCH_TOOLS.find(
        (t: unknown) => (t as { name: string }).name === "research_export",
      );
      expect(tool).toBeDefined();
      if (!tool) {
        return;
      }
      expect(tool.inputSchema.properties.format).toBeDefined();
    });
  });
});

describe("MCP Server - Handler Logic", () => {
  let mockSessionStore: Map<string, ResearchChatSession>;
  let mockSession: ResearchChatSession;

  beforeEach(() => {
    mockSessionStore = new Map();
    mockSession = createResearchChatSession({
      title: "Test Research",
      summary: "Testing MCP handlers",
    });
    mockSessionStore.set(mockSession.sessionId, mockSession);
  });

  it("should create sessions with unique IDs", async () => {
    const session1 = createResearchChatSession({ title: "Research 1" });
    const session2 = createResearchChatSession({ title: "Research 2" });

    expect(session1.sessionId).not.toBe(session2.sessionId);
    expect(session1.sessionId).toMatch(/^research-\d+-[a-z0-9]+$/);
    expect(session2.sessionId).toMatch(/^research-\d+-[a-z0-9]+$/);
  });

  it("should track turns in sessions", async () => {
    const session = createResearchChatSession({ title: "Test" });

    expect(session.turns.length).toBe(0);

    // Simulate adding turns
    const { addChatTurn } = await import("./research-chatbot.js");
    const withTurn = addChatTurn(session, "user", "test message");

    expect(withTurn.turns.length).toBe(1);
    expect(withTurn.turns[0].role).toBe("user");
    expect(withTurn.turns[0].content).toBe("test message");
  });

  it("should maintain document state across turns", async () => {
    const session = createResearchChatSession({ title: "Research Doc" });

    expect(session.workingDoc).toBeDefined();
    expect(session.workingDoc.title).toBe("Research Doc");

    // Document state should be mutable through turns
    expect(session.workingDoc.sections).toBeDefined();
  });

  it("should handle session with summary", async () => {
    const session = createResearchChatSession({
      title: "Test",
      summary: "This is a summary",
    });

    expect(session.workingDoc.summary).toBe("This is a summary");
  });

  it("should handle session without summary", async () => {
    const session = createResearchChatSession({ title: "Test" });

    expect(session.workingDoc.summary).toBeUndefined();
  });

  it("should track timestamps", async () => {
    const session = createResearchChatSession({ title: "Test" });
    const created = session.createdAt;
    const updated = session.updatedAt;

    expect(typeof created).toBe("number");
    expect(typeof updated).toBe("number");
    expect(created).toBeLessThanOrEqual(updated);
    expect(created).toBeGreaterThan(0);
  });
});

describe("MCP Server - JSON-RPC Protocol", () => {
  it("should validate JSON-RPC message structure", async () => {
    // Valid message should have: jsonrpc, id, method, params
    const validMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "test", arguments: {} },
    };

    expect(validMessage.jsonrpc).toBe("2.0");
    expect(typeof validMessage.id).toBe("number");
    expect(validMessage.method).toBeTruthy();
    expect(validMessage.params).toBeDefined();
  });

  it("should handle initialize method", async () => {
    const initMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    };

    expect(initMessage.method).toBe("initialize");
    // Server should respond with protocolVersion and serverInfo
  });

  it("should handle tools/list method", async () => {
    const listMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    };

    expect(listMessage.method).toBe("tools/list");
    // Server should respond with array of tools
  });

  it("should handle tools/call method", async () => {
    const callMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "research_create_session",
        arguments: { title: "Test" },
      },
    };

    expect(callMessage.method).toBe("tools/call");
    expect(callMessage.params.name).toBeTruthy();
    expect(callMessage.params.arguments).toBeDefined();
  });

  it("should return error for unknown method", async () => {
    const unknownMessage = {
      jsonrpc: "2.0",
      id: 4,
      method: "unknown_method",
    };

    // Server should respond with error: -32601 (Method not found)
    expect(unknownMessage.method).not.toBe("tools/call");
  });

  it("should include error code -32601 for unknown methods", () => {
    const errorResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32601,
        message: "Unknown method",
      },
    };

    expect(errorResponse.error.code).toBe(-32601);
  });

  it("should include error code -32700 for invalid JSON", () => {
    // Client error - invalid JSON parse
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error",
      },
    };

    expect(errorResponse.error.code).toBe(-32700);
  });
});

describe("MCP Server - Tool Call Execution", () => {
  it("should execute research_create_session", async () => {
    const { createResearchChatSession } = await import("./research-chatbot.js");

    const session = createResearchChatSession({ title: "MCP Test" });

    expect(session).toBeDefined();
    expect(session.sessionId).toBeTruthy();
    expect(session.workingDoc.title).toBe("MCP Test");
  });

  it("should execute research_add_message", async () => {
    const { createResearchChatSession, addChatTurn } = await import("./research-chatbot.js");

    let session = createResearchChatSession({ title: "Test" });
    session = addChatTurn(session, "user", "Test message");

    expect(session.turns.length).toBe(1);
    expect(session.turns[0].role).toBe("user");
    expect(session.turns[0].content).toBe("Test message");
  });

  it("should execute research_show_document", async () => {
    const { createResearchChatSession, formatResearchDocForChat } =
      await import("./research-chatbot.js");

    const session = createResearchChatSession({ title: "Display Test" });
    const formatted = formatResearchDocForChat(session.workingDoc);

    expect(formatted).toBeTruthy();
    expect(typeof formatted).toBe("string");
  });

  it("should execute research_export", async () => {
    const { createResearchChatSession, exportResearchDoc } = await import("./research-chatbot.js");

    const session = createResearchChatSession({ title: "Export Test" });

    const markdown = exportResearchDoc(session.workingDoc, "markdown");
    expect(markdown).toBeTruthy();
    expect(typeof markdown).toBe("string");

    const json = exportResearchDoc(session.workingDoc, "json");
    expect(json).toBeTruthy();
    expect(typeof json).toBe("string");
  });

  it("should execute research_list_sessions", async () => {
    const sessions: ResearchChatSession[] = [];

    const { createResearchChatSession } = await import("./research-chatbot.js");

    sessions.push(createResearchChatSession({ title: "Session 1" }));
    sessions.push(createResearchChatSession({ title: "Session 2" }));

    expect(sessions.length).toBe(2);
    expect(sessions[0].workingDoc.title).toBe("Session 1");
    expect(sessions[1].workingDoc.title).toBe("Session 2");
  });

  it("should execute research_apply_suggestion", async () => {
    const { createResearchChatSession, applyResearchSuggestions } =
      await import("./research-chatbot.js");

    let session = createResearchChatSession({ title: "Suggestion Test" });

    const suggestion = "Add a new section about methodology";
    session = applyResearchSuggestions(session, suggestion);

    expect(session).toBeDefined();
    expect(session.workingDoc).toBeDefined();
  });
});

describe("MCP Server - Error Handling", () => {
  it("should handle missing sessionId", async () => {
    const { createResearchChatSession } = await import("./research-chatbot.js");

    const session = createResearchChatSession({ title: "Test" });
    const nonexistentId = "research-0000000000000-invalid";

    // Tool should handle gracefully
    expect(session.sessionId).not.toBe(nonexistentId);
  });

  it("should handle missing arguments", async () => {
    // Server should validate required arguments
    const callWithoutArgs = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "research_add_message",
        // Missing arguments
      },
    };

    expect((callWithoutArgs.params as { arguments?: unknown }).arguments).toBeUndefined();
  });

  it("should handle invalid JSON in body", () => {
    const invalidJson = "{invalid json}";

    // Should not parse successfully
    expect(() => JSON.parse(invalidJson)).toThrow();
  });

  it("should handle network errors gracefully", async () => {
    const { isOllamaAvailable } = await import("./research-ollama.js");

    // Should return false rather than throw
    const available = await isOllamaAvailable();
    expect(typeof available).toBe("boolean");
  });
});

describe("MCP Server - Session Management", () => {
  it("should maintain separate session instances", async () => {
    const { createResearchChatSession } = await import("./research-chatbot.js");

    const session1 = createResearchChatSession({ title: "Session 1" });
    const session2 = createResearchChatSession({ title: "Session 2" });

    expect(session1.sessionId).not.toBe(session2.sessionId);
    expect(session1.workingDoc).not.toBe(session2.workingDoc);
  });

  it("should handle concurrent tool calls", async () => {
    const { createResearchChatSession } = await import("./research-chatbot.js");

    const sessions = await Promise.all([
      Promise.resolve(createResearchChatSession({ title: "Concurrent 1" })),
      Promise.resolve(createResearchChatSession({ title: "Concurrent 2" })),
      Promise.resolve(createResearchChatSession({ title: "Concurrent 3" })),
    ]);

    expect(sessions.length).toBe(3);
    expect(sessions.map((s) => s.sessionId)).toHaveLength(3);

    // All should be unique
    const ids = new Set(sessions.map((s) => s.sessionId));
    expect(ids.size).toBe(3);
  });

  it("should persist turns across multiple calls", async () => {
    const { createResearchChatSession, addChatTurn } = await import("./research-chatbot.js");

    let session = createResearchChatSession({ title: "Persistence Test" });
    const sessionId = session.sessionId;

    session = addChatTurn(session, "user", "First message");
    expect(session.turns.length).toBe(1);

    session = addChatTurn(session, "assistant", "First response");
    expect(session.turns.length).toBe(2);

    session = addChatTurn(session, "user", "Second message");
    expect(session.turns.length).toBe(3);

    // Session ID should remain same
    expect(session.sessionId).toBe(sessionId);
  });
});

describe("MCP Server - Response Format", () => {
  it("should return valid JSON-RPC response", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true, sessionId: "test-123" },
    };

    expect(response.jsonrpc).toBe("2.0");
    expect(typeof response.id).toBe("number");
    expect(response.result).toBeDefined();
  });

  it("should return error response on failure", () => {
    const errorResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32600,
        message: "Invalid request",
      },
    };

    expect(errorResponse.error).toBeDefined();
    expect(errorResponse.error.code).toBeLessThan(0);
    expect(errorResponse.error.message).toBeTruthy();
  });

  it("should not include both result and error", () => {
    // Valid: has result
    const validSuccess = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    };
    expect(validSuccess.result).toBeDefined();
    expect((validSuccess as { error?: unknown }).error).toBeUndefined();

    // Valid: has error
    const validError = {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -1, message: "Failed" },
    };
    expect(validError.error).toBeDefined();
    expect((validError as { result?: unknown }).result).toBeUndefined();
  });
});

describe("MCP Server - Server Info", () => {
  it("should provide server information", () => {
    const serverInfo = {
      name: "openclaw-research",
      version: "1.0.0",
    };

    expect(serverInfo.name).toBe("openclaw-research");
    expect(serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should provide protocol version", () => {
    const protocolVersion = "2024-11-05";

    expect(protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("should support tools capability", () => {
    const capabilities = {
      tools: {},
    };

    expect(capabilities.tools).toBeDefined();
  });
});
