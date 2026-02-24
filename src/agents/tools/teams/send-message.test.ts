/**
 * SendMessage Tool Tests
 * Tests for sending messages between team members
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeInboxMessage, listMembers } from "../../../teams/inbox.js";
import { validateTeamNameOrThrow } from "../../../teams/storage.js";
import { createSendMessageTool } from "./send-message.js";

// Mock dependencies
vi.mock("../../../teams/inbox.js", () => ({
  writeInboxMessage: vi.fn(),
  readInboxMessages: vi.fn(),
  listMembers: vi.fn(),
}));

vi.mock("../../../teams/pool.js", () => ({
  getTeamManager: vi.fn(),
}));

vi.mock("../../../teams/storage.js", () => ({
  readTeamConfig: vi.fn(),
  validateTeamNameOrThrow: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

describe("SendMessage Tool", () => {
  const mockTeamName = "test-team";
  const mockTeamsDir = "/tmp/openclaw";
  const mockSenderId = "agent-1";
  const mockRecipientId = "agent-2";
  const mockMessageId = "msg-123";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = mockTeamsDir;
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue(mockMessageId);
    (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  });

  describe("Direct Message", () => {
    it("should write message to recipient inbox", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Hello, team member!",
      });

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith(mockTeamName);
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          id: mockMessageId,
          type: "message",
          from: mockSenderId,
          to: mockRecipientId,
          content: "Hello, team member!",
        }),
      );
      expect(
        (result.details as { messageId: string; type: string; delivered: boolean }).messageId,
      ).toBe(mockMessageId);
      expect((result.details as { messageId: string; type: string; delivered: boolean }).type).toBe(
        "message",
      );
      expect(
        (result.details as { messageId: string; type: string; delivered: boolean }).delivered,
      ).toBe(true);
    });

    it("should generate message ID", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const customMessageId = "custom-msg-456";

      (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue(customMessageId);

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Test message",
      });

      expect(randomUUID).toHaveBeenCalled();
      expect((result.details as { messageId: string }).messageId).toBe(customMessageId);
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          id: customMessageId,
        }),
      );
    });

    it("should set timestamp", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const beforeTimestamp = Date.now();

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Test message",
      });

      const afterTimestamp = Date.now();

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          timestamp: expect.any(Number),
        }),
      );

      const callArgs = (writeInboxMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const messageTimestamp = (callArgs[3] as { timestamp: number }).timestamp;
      expect(messageTimestamp).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(messageTimestamp).toBeLessThanOrEqual(afterTimestamp);
    });
  });

  describe("Broadcast", () => {
    it("should write message to all members inboxes", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { sessionKey: mockSenderId, agentId: "agent-1", agentType: "lead", status: "idle" },
        { sessionKey: mockRecipientId, agentId: "agent-2", agentType: "worker", status: "idle" },
        { sessionKey: "agent-3", agentId: "agent-3", agentType: "worker", status: "idle" },
      ]);

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "broadcast",
        content: "Important announcement for everyone",
      });

      expect(listMembers).toHaveBeenCalledWith(mockTeamName, mockTeamsDir);
      expect(writeInboxMessage).toHaveBeenCalledTimes(2);
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          type: "broadcast",
          from: mockSenderId,
          content: "Important announcement for everyone",
        }),
      );
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        "agent-3",
        expect.objectContaining({
          type: "broadcast",
        }),
      );
      expect((result.details as { delivered: boolean }).delivered).toBe(true);
    });

    it("should exclude sender from broadcast", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { sessionKey: mockSenderId, agentId: "agent-1", agentType: "lead", status: "idle" },
        { sessionKey: mockRecipientId, agentId: "agent-2", agentType: "worker", status: "idle" },
      ]);

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "broadcast",
        content: "Broadcast message",
      });

      expect(writeInboxMessage).toHaveBeenCalledTimes(1);
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.any(Object),
      );
      expect(writeInboxMessage).not.toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockSenderId,
        expect.any(Object),
      );
    });

    it("should handle broadcast with single member (self)", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { sessionKey: mockSenderId, agentId: "agent-1", agentType: "lead", status: "idle" },
      ]);

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "broadcast",
        content: "Solo broadcast",
      });

      expect(writeInboxMessage).not.toHaveBeenCalled();
      expect((result.details as { delivered: boolean }).delivered).toBe(true);
    });
  });

  describe("Message Types", () => {
    it("should support message type", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Direct message content",
      });

      expect((result.details as { type: string }).type).toBe("message");
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          type: "message",
        }),
      );
    });

    it("should support broadcast type", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { sessionKey: mockSenderId, agentId: "agent-1", agentType: "lead", status: "idle" },
        { sessionKey: mockRecipientId, agentId: "agent-2", agentType: "worker", status: "idle" },
      ]);

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "broadcast",
        content: "Broadcast content",
      });

      expect((result.details as { type: string }).type).toBe("broadcast");
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          type: "broadcast",
        }),
      );
    });

    it("should support shutdown_request type", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "shutdown_request",
        recipient: mockRecipientId,
        content: "Task complete, shutting down",
        request_id: "req-123",
      });

      expect((result.details as { type: string }).type).toBe("shutdown_request");
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          type: "shutdown_request",
          requestId: "req-123",
        }),
      );
    });

    it("should support shutdown_response type", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "shutdown_response",
        recipient: mockSenderId,
        content: "Approving shutdown",
        request_id: "req-123",
        approve: true,
      });

      expect((result.details as { type: string }).type).toBe("shutdown_response");
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockSenderId,
        expect.objectContaining({
          type: "shutdown_response",
          requestId: "req-123",
          approve: true,
        }),
      );
    });
  });

  describe("Shutdown Protocol", () => {
    it("should include requestId for shutdown_request", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const requestId = "shutdown-req-789";

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "shutdown_request",
        recipient: mockRecipientId,
        content: "Shutting down now",
        request_id: requestId,
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          requestId,
        }),
      );
    });

    it("should include requestId for shutdown_response", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const requestId = "shutdown-req-789";

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "shutdown_response",
        recipient: mockSenderId,
        content: "Response to shutdown",
        request_id: requestId,
        approve: true,
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockSenderId,
        expect.objectContaining({
          requestId,
        }),
      );
    });

    it("should include approve boolean for shutdown_response", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "shutdown_response",
        recipient: mockSenderId,
        content: "Approving shutdown",
        request_id: "req-123",
        approve: true,
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockSenderId,
        expect.objectContaining({
          approve: true,
        }),
      );
    });

    it("should include reason for rejected shutdown", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "shutdown_response",
        recipient: mockSenderId,
        content: "Not ready to shutdown",
        request_id: "req-123",
        approve: false,
        reason: "Still working on task #3, need 5 more minutes",
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockSenderId,
        expect.objectContaining({
          approve: false,
          reason: "Still working on task #3, need 5 more minutes",
        }),
      );
    });
  });

  describe("Message Summary", () => {
    it("should generate summary from content", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Task completed successfully",
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          summary: "Task completed successfully",
        }),
      );
    });

    it("should limit summary to 10 words", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const longContent =
        "This is a very long message that contains more than ten words and should be truncated automatically by the summary function";

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: longContent,
      });

      const callArgs = (writeInboxMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const summary = (callArgs[3] as { summary: string }).summary;
      const wordCount = summary.split(/\s+/).length;

      expect(wordCount).toBeLessThanOrEqual(10);
      expect(summary).toMatch(/^This is a very long message that contains/);
      expect(summary).toMatch(/\.\.\.$/);
    });

    it("should use provided summary when available", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Long content goes here...",
        summary: "Custom summary",
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          summary: "Custom summary",
        }),
      );
    });
  });

  describe("Validation", () => {
    it("should validate team name format", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const invalidTeamName = "Invalid_Team_Name";

      vi.clearAllMocks();
      (validateTeamNameOrThrow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error(
          `Invalid team name: ${invalidTeamName}. Must contain only lowercase letters, numbers, and hyphens`,
        );
      });

      await expect(
        tool.execute("tool-call-1", {
          team_name: invalidTeamName,
          type: "message",
          recipient: mockRecipientId,
          content: "Test message",
        }),
      ).rejects.toThrow(`Invalid team name: ${invalidTeamName}`);

      expect(validateTeamNameOrThrow).toHaveBeenCalledWith(invalidTeamName);
      expect(writeInboxMessage).not.toHaveBeenCalled();
    });

    it("should validate recipient session key for message type", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        content: "Test message",
      });

      expect((result.details as { error: string }).error).toBe(
        "recipient is required for message type",
      );
      expect(writeInboxMessage).not.toHaveBeenCalled();
    });

    it("should accept content at maximum length", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });
      const maxContentLength = 100_000;
      const maxContent = "a".repeat(maxContentLength);

      const result = await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: maxContent,
      });

      expect((result.details as { delivered: boolean }).delivered).toBe(true);
      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          content: maxContent,
        }),
      );
    });

    it("should require content parameter", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      await expect(
        tool.execute("tool-call-1", {
          team_name: mockTeamName,
          type: "message",
          recipient: mockRecipientId,
        } as unknown),
      ).rejects.toThrow("content required");

      expect(writeInboxMessage).not.toHaveBeenCalled();
    });
  });

  describe("Agent Session Key", () => {
    it("should use provided agent session key as sender", async () => {
      const tool = createSendMessageTool({ agentSessionKey: mockSenderId });

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Test message",
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          from: mockSenderId,
        }),
      );
    });

    it("should use unknown as sender when no session key provided", async () => {
      const tool = createSendMessageTool();

      await tool.execute("tool-call-1", {
        team_name: mockTeamName,
        type: "message",
        recipient: mockRecipientId,
        content: "Test message",
      });

      expect(writeInboxMessage).toHaveBeenCalledWith(
        mockTeamName,
        mockTeamsDir,
        mockRecipientId,
        expect.objectContaining({
          from: "unknown",
        }),
      );
    });
  });
});
