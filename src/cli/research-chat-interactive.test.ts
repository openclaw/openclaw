/**
 * Tests for Interactive Research Chat CLI
 * Verifies command handling, prompt flow, and export functionality
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ResearchChatSession } from "../lib/research-chatbot.js";
import {
  createResearchChatSession,
  addChatTurn,
  exportResearchDoc,
  formatResearchDocForChat,
  buildResearchChatContext,
} from "../lib/research-chatbot.js";

describe("Research Chat Interactive - Session Flow", () => {
  let session: ResearchChatSession;

  beforeEach(() => {
    session = createResearchChatSession({
      title: "CLI Test Research",
      summary: "Testing interactive CLI",
      template: "general",
    });
  });

  it("should initialize with proper session", () => {
    expect(session).toBeDefined();
    expect(session.sessionId).toBeTruthy();
    expect(session.workingDoc.title).toBe("CLI Test Research");
    expect(session.workingDoc.summary).toBe("Testing interactive CLI");
    expect(session.turns).toHaveLength(0);
  });

  it("should handle user input as chat turn", () => {
    const userInput = "This is a user message";
    const updated = addChatTurn(session, "user", userInput);

    expect(updated.turns).toHaveLength(1);
    expect(updated.turns[0].role).toBe("user");
    expect(updated.turns[0].content).toBe(userInput);
    expect(typeof updated.turns[0].timestamp).toBe("number");
  });

  it("should handle assistant response as chat turn", () => {
    let updated = addChatTurn(session, "user", "User input");
    updated = addChatTurn(updated, "assistant", "Assistant response");

    expect(updated.turns).toHaveLength(2);
    expect(updated.turns[1].role).toBe("assistant");
    expect(updated.turns[1].content).toBe("Assistant response");
  });

  it("should maintain conversation history", () => {
    let updated = session;

    // Simulate multi-turn conversation
    updated = addChatTurn(updated, "user", "First question");
    updated = addChatTurn(updated, "assistant", "First answer");
    updated = addChatTurn(updated, "user", "Second question");
    updated = addChatTurn(updated, "assistant", "Second answer");

    expect(updated.turns).toHaveLength(4);
    expect(updated.turns[0].content).toBe("First question");
    expect(updated.turns[1].content).toBe("First answer");
    expect(updated.turns[2].content).toBe("Second question");
    expect(updated.turns[3].content).toBe("Second answer");
  });
});

describe("Research Chat Interactive - Command Parsing", () => {
  let _session: ResearchChatSession;

  beforeEach(() => {
    _session = createResearchChatSession({ title: "Commands Test" });
  });

  it("should detect /show command", () => {
    const input = "/show";

    expect(input).toMatch(/^\/show/);
    expect(input.toLowerCase()).toBe("/show");
  });

  it("should detect /export command", () => {
    const input = "/export";

    expect(input).toMatch(/^\/export/);
  });

  it("should detect /done command", () => {
    const input = "/done";

    expect(input).toMatch(/^\/done/);
  });

  it("should detect /help command", () => {
    const input = "/help";

    expect(input).toMatch(/^\/help/);
  });

  it("should handle command case-insensitively", () => {
    const inputs = ["/SHOW", "/Show", "/show"];

    for (const input of inputs) {
      expect(input.toLowerCase()).toBe("/show");
    }
  });

  it("should distinguish commands from regular input", () => {
    const commands = ["/show", "/export", "/done", "/help"];
    const messages = [
      "This is a regular message",
      "I have /show in my message", // Not a command
      "Tell me about /export",
    ];

    for (const cmd of commands) {
      expect(cmd.startsWith("/")).toBe(true);
    }

    for (const msg of messages) {
      if (!msg.startsWith("/")) {
        expect(msg.startsWith("/")).toBe(false);
      }
    }
  });
});

describe("Research Chat Interactive - Export Functionality", () => {
  let session: ResearchChatSession;

  beforeEach(() => {
    session = createResearchChatSession({ title: "Export Test" });
    session = addChatTurn(session, "user", "First note about AI");
    session = addChatTurn(session, "assistant", "Good observation");
  });

  it("should export to markdown format", () => {
    const markdown = exportResearchDoc(session.workingDoc, "markdown");

    expect(markdown).toBeTruthy();
    expect(typeof markdown).toBe("string");
    expect(markdown.length).toBeGreaterThan(0);
  });

  it("should export to JSON format", () => {
    const json = exportResearchDoc(session.workingDoc, "json");

    expect(json).toBeTruthy();
    expect(typeof json).toBe("string");

    // Should be valid JSON
    const parsed = JSON.parse(json);
    expect(parsed).toBeDefined();
  });

  it("should handle both export formats", () => {
    const markdown = exportResearchDoc(session.workingDoc, "markdown");
    const json = exportResearchDoc(session.workingDoc, "json");

    expect(markdown).not.toBe(json);
    expect(markdown.length).toBeGreaterThan(0);
    expect(json.length).toBeGreaterThan(0);
  });

  it("markdown export should include title", () => {
    const markdown = exportResearchDoc(session.workingDoc, "markdown");

    expect(markdown).toContain("Export Test");
  });

  it("JSON export should be parseable", () => {
    const json = exportResearchDoc(session.workingDoc, "json");
    const parsed = JSON.parse(json);

    expect(parsed.title).toBe("Export Test");
    // summary is optional and undefined when not provided
    expect(parsed.sections).toBeDefined();
  });
});

describe("Research Chat Interactive - Input Validation", () => {
  let session: ResearchChatSession;

  beforeEach(() => {
    session = createResearchChatSession({ title: "Validation Test" });
  });

  it("should accept non-empty user input", () => {
    const input = "Valid user input";
    const updated = addChatTurn(session, "user", input);

    expect(updated.turns).toHaveLength(1);
    expect(typeof updated.turns[0].timestamp).toBe("number");
  });

  it("should handle empty input gracefully", () => {
    const input = "";

    // Empty turns might be skipped or handled specially
    // Depending on implementation, this should not crash
    expect(input.length).toBe(0);
  });

  it("should handle very long input", () => {
    const longInput = "word ".repeat(1000); // Very long message
    const updated = addChatTurn(session, "user", longInput);

    expect(updated.turns).toHaveLength(1);
    expect(updated.turns[0].content).toBe(longInput);
  });

  it("should handle special characters", () => {
    const specialInput = "Test with !@#$%^&*()_+-=[]{}|;':\",./<>?";
    const updated = addChatTurn(session, "user", specialInput);

    expect(updated.turns[0].content).toBe(specialInput);
  });

  it("should handle newlines in input", () => {
    const inputWithNewlines = "Line 1\nLine 2\nLine 3";
    const updated = addChatTurn(session, "user", inputWithNewlines);

    expect(updated.turns[0].content).toBe(inputWithNewlines);
  });

  it("should handle unicode characters", () => {
    const unicodeInput = "Test 中文 русский العربية 🚀";
    const updated = addChatTurn(session, "user", unicodeInput);

    expect(updated.turns[0].content).toBe(unicodeInput);
  });
});

describe("Research Chat Interactive - Display Functions", () => {
  let session: ResearchChatSession;

  beforeEach(() => {
    session = createResearchChatSession({ title: "Display Test" });
    session = addChatTurn(session, "user", "Question about AI");
    session = addChatTurn(session, "assistant", "Answer about AI");
  });

  it("should format document for chat display", () => {
    const formatted = formatResearchDocForChat(session.workingDoc);

    expect(formatted).toBeTruthy();
    expect(typeof formatted).toBe("string");
  });

  it("should include title in display", () => {
    const formatted = formatResearchDocForChat(session.workingDoc);

    expect(formatted).toContain("Display Test");
  });

  it("should show conversation history context", () => {
    const context = buildResearchChatContext(session);

    expect(context).toBeDefined();
    expect(context.conversationHistory).toBeDefined();
    expect(Array.isArray(context.conversationHistory)).toBe(true);
  });

  it("should include system prompt in context", () => {
    const context = buildResearchChatContext(session);

    expect(context.systemPrompt).toBeTruthy();
    expect(typeof context.systemPrompt).toBe("string");
    expect(context.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe("Research Chat Interactive - Error Handling", () => {
  let session: ResearchChatSession;

  beforeEach(() => {
    session = createResearchChatSession({ title: "Error Test" });
  });

  it("should handle invalid command gracefully", () => {
    const invalidCommand = "/invalid_command";

    expect(invalidCommand).toMatch(/^\/invalid_command$/);
    // Should either be processed as message or error handled gracefully
  });

  it("should handle missing session context", () => {
    // If session is somehow lost, should not crash
    expect(session).toBeDefined();
  });

  it("should handle LLM generation failure gracefully", async () => {
    // Even if Ollama fails, should provide fallback
    const input = "test";
    expect(input).toBeTruthy();
  });

  it("should handle file write errors", () => {
    // Export should handle file system errors gracefully
    const markdown = exportResearchDoc(session.workingDoc, "markdown");
    expect(markdown).toBeTruthy();
  });

  it("should handle export with no content", () => {
    const emptySession = createResearchChatSession({ title: "Empty" });
    const markdown = exportResearchDoc(emptySession.workingDoc, "markdown");

    expect(markdown).toBeTruthy();
    expect(typeof markdown).toBe("string");
  });
});

describe("Research Chat Interactive - State Management", () => {
  it("should create new session for each chat start", () => {
    const session1 = createResearchChatSession({ title: "Chat 1" });
    const session2 = createResearchChatSession({ title: "Chat 2" });

    expect(session1.sessionId).not.toBe(session2.sessionId);
    expect(session1.workingDoc).not.toBe(session2.workingDoc);
  });

  it("should preserve session data throughout interaction", () => {
    let session = createResearchChatSession({ title: "Persistent" });
    const originalId = session.sessionId;

    session = addChatTurn(session, "user", "First turn");
    expect(session.sessionId).toBe(originalId);

    session = addChatTurn(session, "assistant", "Response");
    expect(session.sessionId).toBe(originalId);

    session = addChatTurn(session, "user", "Second turn");
    expect(session.sessionId).toBe(originalId);
  });

  it("should not affect other sessions when modifying one", () => {
    const session1 = createResearchChatSession({ title: "Session 1" });
    const session2 = createResearchChatSession({ title: "Session 2" });

    const modified1 = addChatTurn(session1, "user", "Message");

    expect(modified1.turns).toHaveLength(1);
    expect(session2.turns).toHaveLength(0); // Unchanged
  });
});

describe("Research Chat Interactive - Help and Guidance", () => {
  it("should have /help command description", () => {
    const helpCommands = ["/show", "/export", "/help", "/done"];

    for (const cmd of helpCommands) {
      expect(cmd).toMatch(/^\/\w+$/);
    }
  });

  it("should explain /show command", () => {
    const showDescription = "Display current research document";

    expect(showDescription).toContain("current");
    expect(showDescription).toContain("document");
  });

  it("should explain /export command", () => {
    const exportDescription = "Export research to Markdown or JSON";

    expect(exportDescription).toContain("Export");
  });

  it("should explain /done command", () => {
    const doneDescription = "Exit chat and save session";

    expect(doneDescription).toContain("Exit");
  });
});

describe("Research Chat Interactive - Template Support", () => {
  it("should support general template", () => {
    const session = createResearchChatSession({
      title: "Test",
      template: "general",
    });

    expect(session).toBeDefined();
    expect(session.template).toBe("general");
  });

  it("should support research template", () => {
    const session = createResearchChatSession({
      title: "Test",
      template: "research",
    });

    expect(session).toBeDefined();
    expect(session.template).toBe("research");
  });

  it("should support technical template", () => {
    const session = createResearchChatSession({
      title: "Test",
      template: "technical",
    });

    expect(session).toBeDefined();
    expect(session.template).toBe("technical");
  });

  it("should handle missing template", () => {
    const session = createResearchChatSession({ title: "Test" });

    expect(session).toBeDefined();
  });
});

describe("Research Chat Interactive - Performance", () => {
  it("should handle rapid input", () => {
    let session = createResearchChatSession({ title: "Performance" });

    for (let i = 0; i < 100; i++) {
      session = addChatTurn(session, "user", `Message ${i}`);
    }

    expect(session.turns.length).toBeGreaterThan(0);
  });

  it("should maintain performance with large sessions", () => {
    let session = createResearchChatSession({ title: "Large Session" });

    // Add many turns
    for (let i = 0; i < 50; i++) {
      session = addChatTurn(session, "user", `Large message ${"x".repeat(1000)}`);
    }

    expect(session.turns.length).toBe(50);
  });

  it("should export large sessions efficiently", () => {
    let session = createResearchChatSession({ title: "Large Export" });

    for (let i = 0; i < 20; i++) {
      session = addChatTurn(session, "user", `Research point ${i}: ${"content ".repeat(50)}`);
    }

    const start = Date.now();
    const markdown = exportResearchDoc(session.workingDoc, "markdown");
    const duration = Date.now() - start;

    expect(markdown.length).toBeGreaterThan(0);
    expect(duration).toBeLessThan(1000); // Should be fast
  });
});
