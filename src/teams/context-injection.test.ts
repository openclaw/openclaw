/**
 * Message Injection Tests
 * Tests for converting pending inbox messages to XML for agent context
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { injectPendingMessages } from "./context-injection.js";
import * as inbox from "./inbox.js";

vi.mock("./inbox.js", () => ({
  readInboxMessages: vi.fn(),
  clearInboxMessages: vi.fn(),
}));

// Helper to create mock SessionEntry with required fields
const createMockSession = (
  partial: Partial<SessionEntry> & { teamId?: string; sessionKey?: string },
): SessionEntry =>
  ({
    sessionId: partial.sessionId ?? "test-session-id",
    updatedAt: partial.updatedAt ?? Date.now(),
    ...partial,
  }) as SessionEntry;

describe("Message Injection", () => {
  const mockStateDir = "/mock/state";
  const mockTeamName = "test-team";
  const mockSessionKey = "test-session-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Message Injection", () => {
    it("should read pending messages from inbox", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Hello there",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(inbox.readInboxMessages).toHaveBeenCalledWith(
        mockTeamName,
        mockStateDir,
        mockSessionKey,
      );
      expect(result).toContain("<teammate-message");
    });

    it("should generate XML tags for each message", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          summary: "Status update",
          content: "Task is complete",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("<teammate-message");
      expect(result).toContain('teammate_id="researcher"');
      expect(result).toContain('type="message"');
      expect(result).toContain('summary="Status update"');
    });

    it("should clear processed messages after reading", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Test",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      await injectPendingMessages(session, mockStateDir);

      expect(inbox.clearInboxMessages).toHaveBeenCalledWith(
        mockTeamName,
        mockStateDir,
        mockSessionKey,
      );
    });
  });

  describe("XML Format", () => {
    it("should generate <teammate-message> with attributes", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "shutdown_request",
          requestId: "req-123",
          content: "Time to shut down",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toMatch(
        /<teammate-message\s+teammate_id="researcher"\s+type="shutdown_request"\s+request_id="req-123">/,
      );
    });

    it("should include content between tags", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          content: "This is the message content",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("This is the message content");
    });

    it("should generate closing tag", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Test",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("</teammate-message>");
    });
  });

  describe("XML Escaping", () => {
    it("should escape XML special characters", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          content: "Test <tag> & \"quotes\" 'apostrophe'",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("&lt;tag&gt;");
      expect(result).toContain("&amp;");
      expect(result).toContain("&quot;");
      expect(result).toContain("&apos;");
    });

    it("should escape & to &amp;", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "A & B & C",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("A &amp; B &amp; C");
    });

    it("should escape < to &lt;", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: '<script>alert("xss")</script>',
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("&lt;script&gt;");
    });
  });

  describe("No Team Context", () => {
    it("should return empty string when no teamId", async () => {
      const session = createMockSession({
        sessionKey: mockSessionKey,
      });
      // Explicitly remove teamId for this test
      delete (session as Partial<SessionEntry>).teamId;

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toBe("");
      expect(inbox.readInboxMessages).not.toHaveBeenCalled();
    });

    it("should return empty string when no sessionKey", async () => {
      const session = createMockSession({
        teamId: mockTeamName,
      });
      // Explicitly remove sessionKey for this test - note: sessionKey is not on SessionEntry
      // The test is checking what happens when injectPendingMessages gets incomplete session

      const result = await injectPendingMessages(
        { ...session, sessionKey: undefined } as unknown as SessionEntry,
        mockStateDir,
      );

      expect(result).toBe("");
      expect(inbox.readInboxMessages).not.toHaveBeenCalled();
    });

    it("should return empty string when empty inbox", async () => {
      vi.mocked(inbox.readInboxMessages).mockResolvedValue([]);

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toBe("");
      expect(inbox.clearInboxMessages).not.toHaveBeenCalled();
    });
  });

  describe("Multiple Messages", () => {
    it("should process messages in order", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "First",
        },
        { id: "msg-2", from: "tester", type: "message", timestamp: Date.now(), content: "Second" },
        {
          id: "msg-3",
          from: "implementer",
          type: "message",
          timestamp: Date.now(),
          content: "Third",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      const firstIndex = result.indexOf("First");
      const secondIndex = result.indexOf("Second");
      const thirdIndex = result.indexOf("Third");

      expect(firstIndex).toBeLessThan(secondIndex);
      expect(secondIndex).toBeLessThan(thirdIndex);
    });

    it("should generate separate XML blocks", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Message 1",
        },
        {
          id: "msg-2",
          from: "tester",
          type: "message",
          timestamp: Date.now(),
          content: "Message 2",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      const openTags = result.match(/<teammate-message/g) || [];
      const closeTags = result.match(/<\/teammate-message>/g) || [];

      expect(openTags.length).toBe(2);
      expect(closeTags.length).toBe(2);
    });

    it("should clear all messages after processing", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Msg 1",
        },
        { id: "msg-2", from: "tester", type: "message", timestamp: Date.now(), content: "Msg 2" },
        {
          id: "msg-3",
          from: "implementer",
          type: "message",
          timestamp: Date.now(),
          content: "Msg 3",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      await injectPendingMessages(session, mockStateDir);

      expect(inbox.clearInboxMessages).toHaveBeenCalledTimes(1);
    });
  });

  describe("Message Persistence", () => {
    it("should preserve messages if recipient offline", async () => {
      // Messages persist in inbox until read - this is tested by
      // verifying readInboxMessages returns persisted messages
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Stored while offline",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("Stored while offline");
    });

    it("should process messages on next inference", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "message",
          timestamp: Date.now(),
          content: "Delayed message",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain("Delayed message");
      expect(result).toContain("<teammate-message");
    });
  });

  describe("Message Types", () => {
    it("should handle shutdown_response with approval", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "shutdown_response",
          requestId: "req-456",
          approve: true,
          content: "Approved",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain('type="shutdown_response"');
      expect(result).toContain('request_id="req-456"');
      expect(result).toContain('approve="true"');
    });

    it("should handle shutdown_response with rejection and reason", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher",
          type: "shutdown_response",
          requestId: "req-789",
          approve: false,
          reason: "Still working on task",
          content: "Not approved",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain('type="shutdown_response"');
      expect(result).toContain('approve="false"');
      expect(result).toContain('reason="Still working on task"');
    });

    it("should handle broadcast messages", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "lead",
          type: "broadcast",
          summary: "Critical update",
          content: "All team members stop work",
          timestamp: Date.now(),
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain('type="broadcast"');
      expect(result).toContain('summary="Critical update"');
    });
  });

  describe("Agent Name Resolution", () => {
    it("should resolve agent name from session key with hyphen", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "researcher-abc123",
          type: "message",
          timestamp: Date.now(),
          content: "Hello",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain('teammate_id="researcher"');
    });

    it("should use full session key if no hyphen present", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          from: "simplekey",
          type: "message",
          timestamp: Date.now(),
          content: "Hello",
        },
      ];
      vi.mocked(inbox.readInboxMessages).mockResolvedValue(mockMessages);
      vi.mocked(inbox.clearInboxMessages).mockResolvedValue();

      const session = createMockSession({
        teamId: mockTeamName,
        sessionKey: mockSessionKey,
      });

      const result = await injectPendingMessages(session, mockStateDir);

      expect(result).toContain('teammate_id="simplekey"');
    });
  });
});
