/**
 * Inbox Tool Tests
 * Tests for reading pending messages from teammates
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readInboxMessages, clearInboxMessages } from "../../../teams/inbox.js";
import { validateTeamNameOrThrow } from "../../../teams/storage.js";
import { createInboxTool } from "./inbox.js";

// Mock dependencies
vi.mock("../../../teams/inbox.js", () => ({
  readInboxMessages: vi.fn(),
  clearInboxMessages: vi.fn(),
}));

vi.mock("../../../teams/storage.js", () => ({
  validateTeamNameOrThrow: vi.fn(),
}));

describe("Inbox Tool", () => {
  const mockTeamName = "test-team";
  const mockTeamsDir = "/tmp/openclaw";
  const mockSessionKey = "agent:main:user@example.com:teammate:abc123";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = mockTeamsDir;
    (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  });

  describe("Basic Functionality", () => {
    it("should return empty array when no messages", async () => {
      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith(mockTeamName);
      expect(readInboxMessages).toHaveBeenCalledWith(mockTeamName, mockTeamsDir, mockSessionKey);
      expect((result.details as { count: number }).count).toBe(0);
      expect((result.details as { messages: unknown[] }).messages).toEqual([]);
      expect(clearInboxMessages).not.toHaveBeenCalled();
    });

    it("should return messages from inbox", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "agent:main:user@example.com:main",
          to: mockSessionKey,
          content: "Hello teammate!",
          summary: "Hello teammate!",
          timestamp: 1234567890,
        },
        {
          id: "msg-2",
          type: "broadcast",
          from: "agent:main:user@example.com:main",
          content: "Team announcement",
          summary: "Team announcement",
          timestamp: 1234567891,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      expect((result.details as { count: number }).count).toBe(2);
      expect((result.details as { messages: unknown[] }).messages).toHaveLength(2);
    });

    it("should clear messages by default after reading", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          content: "Test",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      expect(clearInboxMessages).toHaveBeenCalledWith(mockTeamName, mockTeamsDir, mockSessionKey);
    });

    it("should preserve messages when clear is false", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          content: "Test",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        clear: false,
      });

      expect(clearInboxMessages).not.toHaveBeenCalled();
    });

    it("should not clear when no messages exist", async () => {
      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        clear: true,
      });

      expect(clearInboxMessages).not.toHaveBeenCalled();
    });
  });

  describe("Message Formatting", () => {
    it("should format message with summary", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          summary: "Custom summary",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ summary?: string }> }).messages;
      expect(messages[0].summary).toBe("Custom summary");
    });

    it("should generate summary from content when no summary provided", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          content: "Short content",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ summary?: string }> }).messages;
      expect(messages[0].summary).toBe("Short content");
    });

    it("should truncate long content for summary", async () => {
      const longContent =
        "This is a very long message that contains more than ten words and should be truncated automatically";
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          content: longContent,
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ summary?: string }> }).messages;
      expect(messages[0].summary).toBe("This is a very long message that contains more than...");
    });

    it("should include timestamp in formatted message", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          content: "Test",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ timestamp?: number }> }).messages;
      expect(messages[0].timestamp).toBe(1234567890);
    });

    it("should include request_id for shutdown_request", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "shutdown_request",
          from: "sender",
          content: "Shutting down",
          requestId: "req-123",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ request_id?: string }> }).messages;
      expect(messages[0].request_id).toBe("req-123");
    });

    it("should include approve and reason for shutdown_response", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "shutdown_response",
          from: "sender",
          content: "Shutdown rejected",
          requestId: "req-123",
          approve: false,
          reason: "Still working on task",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (
        result.details as { messages: Array<{ approve?: boolean; reason?: string }> }
      ).messages;
      expect(messages[0].approve).toBe(false);
      expect(messages[0].reason).toBe("Still working on task");
    });

    it("should include approve for approved shutdown_response", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "shutdown_response",
          from: "sender",
          content: "Shutdown approved",
          requestId: "req-123",
          approve: true,
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ approve?: boolean }> }).messages;
      expect(messages[0].approve).toBe(true);
    });
  });

  describe("Validation", () => {
    it("should validate team name format", async () => {
      const invalidTeamName = "Invalid_Team_Name";

      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          `Invalid team name: ${invalidTeamName}. Must contain only lowercase letters, numbers, and hyphens`,
        );
      });

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      await expect(
        tool.execute("tool-call-1", {
          team_name: invalidTeamName,
        }),
      ).rejects.toThrow(`Invalid team name: ${invalidTeamName}`);

      expect(readInboxMessages).not.toHaveBeenCalled();
    });

    it("should return error when no session key", async () => {
      const tool = createInboxTool();

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      expect((result.details as { error: string }).error).toBe(
        "No session key available. This tool requires an active agent session.",
      );
      expect(readInboxMessages).not.toHaveBeenCalled();
    });

    it("should require team_name parameter", async () => {
      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      await expect(tool.execute("tool-call-1", {} as unknown)).rejects.toThrow(
        "team_name required",
      );
    });
  });

  describe("Session Key Handling", () => {
    it("should use provided agent session key", async () => {
      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      expect(readInboxMessages).toHaveBeenCalledWith(mockTeamName, mockTeamsDir, mockSessionKey);
    });

    it("should use different session keys for different teammates", async () => {
      const sessionKey1 = "agent:main:user@example.com:teammate:abc123";
      const sessionKey2 = "agent:main:user@example.com:teammate:def456";

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool1 = createInboxTool({ agentSessionKey: sessionKey1 });
      const tool2 = createInboxTool({ agentSessionKey: sessionKey2 });

      await tool1.execute("tool-call-1", { team_name: mockTeamName });
      await tool2.execute("tool-call-2", { team_name: mockTeamName });

      expect(readInboxMessages).toHaveBeenCalledWith(mockTeamName, mockTeamsDir, sessionKey1);
      expect(readInboxMessages).toHaveBeenCalledWith(mockTeamName, mockTeamsDir, sessionKey2);
    });
  });

  describe("Message Types", () => {
    it("should handle message type", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "message",
          from: "sender",
          content: "Direct message",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ type: string }> }).messages;
      expect(messages[0].type).toBe("message");
    });

    it("should handle broadcast type", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "broadcast",
          from: "sender",
          content: "Team broadcast",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ type: string }> }).messages;
      expect(messages[0].type).toBe("broadcast");
    });

    it("should handle shutdown_request type", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "shutdown_request",
          from: "sender",
          content: "Shutting down",
          requestId: "req-123",
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ type: string }> }).messages;
      expect(messages[0].type).toBe("shutdown_request");
    });

    it("should handle shutdown_response type", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          type: "shutdown_response",
          from: "sender",
          content: "Response",
          requestId: "req-123",
          approve: true,
          timestamp: 1234567890,
        },
      ];

      (readInboxMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const tool = createInboxTool({ agentSessionKey: mockSessionKey });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
      });

      const messages = (result.details as { messages: Array<{ type: string }> }).messages;
      expect(messages[0].type).toBe("shutdown_response");
    });
  });
});
