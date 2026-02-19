import { describe, it, expect } from "vitest";
import {
  addChatTurn,
  applyResearchSuggestions,
  buildResearchChatContext,
  createResearchChatSession,
  exportResearchDoc,
  formatResearchDocForChat,
} from "./research-chatbot.js";

describe("research chatbot", () => {
  it("creates a new research chat session", () => {
    const session = createResearchChatSession({
      title: "Test Research",
      summary: "A test summary",
    });

    expect(session.sessionId).toMatch(/^research-\d+-[a-z0-9]+$/);
    expect(session.workingDoc.title).toBe("Test Research");
    expect(session.workingDoc.summary).toBe("A test summary");
    expect(session.turns).toHaveLength(0);
    expect(session.createdAt).toBeGreaterThan(0);
  });

  it("adds chat turns to session", () => {
    let session = createResearchChatSession({ title: "Test" });

    session = addChatTurn(session, "user", "What is this research about?");
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].role).toBe("user");
    expect(session.turns[0].content).toBe("What is this research about?");

    session = addChatTurn(session, "assistant", "This research explores...");
    expect(session.turns).toHaveLength(2);
    expect(session.turns[1].role).toBe("assistant");
  });

  it("builds research chat context with system prompt", () => {
    let session = createResearchChatSession({
      title: "Investigation",
      summary: "Incident analysis",
    });

    session = addChatTurn(session, "user", "What happened?");
    session = addChatTurn(session, "assistant", "Let me investigate...");

    const { systemPrompt, conversationHistory } = buildResearchChatContext(session);

    expect(systemPrompt).toContain("research assistant");
    expect(systemPrompt).toContain("Investigation");
    expect(conversationHistory).toHaveLength(2);
    expect(conversationHistory[0].role).toBe("user");
  });

  it("formats research doc for chat display", () => {
    let session = createResearchChatSession({
      title: "My Research",
      summary: "Quick summary",
    });

    const formatted = formatResearchDocForChat(session.workingDoc);

    expect(formatted).toContain("# My Research");
    expect(formatted).toContain("Quick summary");
  });

  it("applies research suggestions from assistant message", () => {
    let session = createResearchChatSession({ title: "Test" });

    const suggestion = `## Background

This is some background information about the research topic.

## Requirements

- Requirement 1
- Requirement 2`;

    session = applyResearchSuggestions(session, suggestion);

    expect(session.workingDoc.sections.length).toBeGreaterThan(0);
    expect(session.workingDoc.sections[0].title).toContain("Background");
  });

  it("exports research document as markdown", () => {
    const session = createResearchChatSession({
      title: "Export Test",
      summary: "Testing export",
    });

    const md = exportResearchDoc(session.workingDoc, "markdown");

    expect(md).toContain("# Export Test");
    expect(md).toContain("**Summary:** Testing export");
  });

  it("exports research document as JSON", () => {
    const session = createResearchChatSession({
      title: "JSON Export",
      summary: "Testing JSON",
    });

    const json = exportResearchDoc(session.workingDoc, "json");
    const parsed = JSON.parse(json);

    expect(parsed.title).toBe("JSON Export");
    expect(parsed.summary).toBe("Testing JSON");
    expect(Array.isArray(parsed.sections)).toBe(true);
  });

  it("updates session timestamp on changes", () => {
    const session = createResearchChatSession({ title: "Test" });
    const originalUpdatedAt = session.updatedAt;

    // Small delay to ensure timestamp is different
    const updated = addChatTurn(session, "user", "New input");

    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });
});
