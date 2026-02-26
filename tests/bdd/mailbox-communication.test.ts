// TODO: These tests need proper mock implementation for TeamManager
/**
 * Mailbox Communication Step Definitions
 * BDD step definitions for mailbox communication feature
 * Based on OpenClaw Agent Teams Design (2026-02-23)
 */

import * as fs from "fs/promises";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSendMessageTool } from "../../src/agents/tools/teams/send-message";
import { readInboxMessages, clearInboxMessages, listMembers } from "../../src/teams/inbox";

const TEST_STATE_DIR = "/tmp/test-teams";
const TEST_TEAM_NAME = "msg-team";

// Mock all dependencies at module level
vi.mock("fs/promises");
vi.mock("node:crypto");
vi.mock("../../src/teams/storage");
vi.mock("../../src/teams/pool");
vi.mock("../../src/teams/inbox");

describe.skip("Mailbox Communication Feature", () => { // TODO: Fix mock implementation
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = TEST_STATE_DIR;
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue("msg-test-uuid");
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.appendFile).mockResolvedValue(undefined);
  });

  describe("Direct Messaging", () => {
    describe("Scenario: Send direct message to teammate", () => {
      it("Send direct message to teammate", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        const result = await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "worker-1",
          content: "Hello, team member!",
        });

        expect(result.details?.delivered).toBe(true);
        expect(vi.mocked(fs.appendFile)).toHaveBeenCalled();

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        expect(filePath).toContain("inbox/worker-1/messages.jsonl");
      });
    });

    describe("Scenario: Message delivery is automatic", () => {
      it("Message delivery is automatic", async () => {
        const message = { id: "msg-1", content: "Test message" };
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(message) + "\n");

        const messages = await readInboxMessages(TEST_TEAM_NAME, TEST_STATE_DIR, "worker-1");
        expect(messages).toHaveLength(1);
        expect(messages[0]).toHaveProperty("content", "Test message");
      });
    });

    describe("Scenario: Message delivered only to intended recipient", () => {
      it("Message delivered only to intended recipient", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "worker-1",
          content: "Direct message",
        });

        expect(vi.mocked(fs.appendFile)).toHaveBeenCalledTimes(1);

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        expect(filePath).toContain("inbox/worker-1/messages.jsonl");
        expect(filePath).not.toContain("inbox/worker-2");
        expect(filePath).not.toContain("inbox/lead");
      });
    });

    describe("Scenario: Plain text output is NOT visible to teammates", () => {
      it("Plain text output is NOT visible to teammates", async () => {
        vi.clearAllMocks();
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "worker-1",
          content: "Team message via SendMessage",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);

        expect(messageObj.content).toBe("Team message via SendMessage");
        expect(messageObj.from).toBe("lead");
      });
    });
  });

  describe("Broadcast Messaging", () => {
    describe("Scenario: Broadcast message to all teammates", () => {
      beforeEach(() => {
        (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
          { name: "worker-1", agentId: "agent-1" },
          { name: "worker-2", agentId: "agent-2" },
        ]);
      });

      it("Broadcast message to all teammates", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        const result = await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "broadcast",
          content: "Team announcement",
        });

        expect(result.details?.delivered).toBe(true);
        expect(vi.mocked(fs.appendFile)).toHaveBeenCalledTimes(2);

        const allCalls = vi.mocked(fs.appendFile).mock.calls;
        allCalls.forEach((call) => {
          const filePath = call[0] as string;
          expect(filePath).toContain("inbox/");
          expect(filePath).not.toContain("inbox/lead");
        });
      });
    });

    describe("Scenario: Broadcast delivers to all N teammates", () => {
      beforeEach(() => {
        (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
          { name: "worker-1", agentId: "agent-1" },
          { name: "worker-2", agentId: "agent-2" },
          { name: "worker-3", agentId: "agent-3" },
          { name: "worker-4", agentId: "agent-4" },
          { name: "worker-5", agentId: "agent-5" },
        ]);
      });

      it("Broadcast delivers to all N teammates", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "broadcast",
          content: "Broadcast to all",
        });

        expect(vi.mocked(fs.appendFile)).toHaveBeenCalledTimes(5);
      });
    });

    describe("Scenario: Broadcast excludes sender", () => {
      beforeEach(() => {
        (listMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
          { name: "worker-2", agentId: "agent-2" },
          { name: "lead", agentId: "agent-lead" },
          { name: "worker-1", agentId: "agent-1" },
        ]);
      });

      it("Broadcast excludes sender", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "worker-2" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "broadcast",
          content: "Broadcast from worker-2",
        });

        const allCalls = vi.mocked(fs.appendFile).mock.calls;
        const worker2Calls = allCalls.filter((call) => {
          const filePath = call[0] as string;
          return filePath.includes("inbox/worker-2");
        });
        expect(worker2Calls).toHaveLength(0);
      });
    });
  });

  describe("Shutdown Protocol", () => {
    describe("Scenario: Send shutdown request to member", () => {
      it("Send shutdown request to member", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "shutdown_request",
          recipient: "worker-1",
          content: "Shutdown requested",
          request_id: "req-123",
        });

        expect(vi.mocked(fs.appendFile)).toHaveBeenCalled();

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        expect(filePath).toContain("inbox/worker-1/messages.jsonl");

        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        expect(messageObj).toHaveProperty("requestId", "req-123");
      });
    });

    describe("Scenario: Shutdown response with approval", () => {
      it("Shutdown response with approval", async () => {
        vi.mocked(fs.readFile).mockResolvedValue(
          JSON.stringify({
            id: "msg-1",
            type: "shutdown_request",
            requestId: "abc-123",
            content: "Shutdown requested",
          }) + "\n",
        );

        const messages = await readInboxMessages(TEST_TEAM_NAME, TEST_STATE_DIR, "worker-1");
        expect(messages).toHaveLength(1);
        expect(messages[0]).toHaveProperty("requestId", "abc-123");

        vi.clearAllMocks();
        const tool = createSendMessageTool({ agentSessionKey: "worker-1" });

        await tool.execute("tool-call-2", {
          team_name: TEST_TEAM_NAME,
          type: "shutdown_response",
          recipient: "lead",
          content: "Approving shutdown",
          request_id: "abc-123",
          approve: true,
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        expect(filePath).toContain("inbox/lead/messages.jsonl");

        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        expect(messageObj).toHaveProperty("requestId", "abc-123");
        expect(messageObj).toHaveProperty("approve", true);
      });
    });

    describe("Scenario: Shutdown response with rejection and reason", () => {
      it("Shutdown response with rejection and reason", async () => {
        vi.mocked(fs.readFile).mockResolvedValue(
          JSON.stringify({
            id: "msg-1",
            type: "shutdown_request",
            requestId: "req-456",
            content: "Shutdown requested",
          }) + "\n",
        );

        await readInboxMessages(TEST_TEAM_NAME, TEST_STATE_DIR, "worker-1");

        vi.clearAllMocks();
        const tool = createSendMessageTool({ agentSessionKey: "worker-1" });

        await tool.execute("tool-call-2", {
          team_name: TEST_TEAM_NAME,
          type: "shutdown_response",
          recipient: "lead",
          content: "Not ready to shutdown",
          request_id: "req-456",
          approve: false,
          reason: "Busy",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        expect(filePath).toContain("inbox/lead/messages.jsonl");

        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        expect(messageObj).toHaveProperty("approve", false);
        expect(messageObj).toHaveProperty("reason", "Busy");
      });
    });

    describe("Scenario: Shutdown protocol includes request_id", () => {
      it("Shutdown protocol includes request_id", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "shutdown_request",
          recipient: "worker-1",
          content: "Shutdown",
          request_id: "unique-req-id",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        expect(messageObj).toHaveProperty("requestId", "unique-req-id");
        expect(typeof messageObj.requestId).toBe("string");
      });
    });

    describe("Scenario: Response matches request_id", () => {
      it("Response matches request_id", async () => {
        vi.mocked(fs.readFile).mockResolvedValue(
          JSON.stringify({
            id: "msg-1",
            type: "shutdown_request",
            requestId: "xyz-789",
            content: "Shutdown",
          }) + "\n",
        );

        await readInboxMessages(TEST_TEAM_NAME, TEST_STATE_DIR, "worker-1");

        vi.clearAllMocks();
        const tool = createSendMessageTool({ agentSessionKey: "worker-1" });

        await tool.execute("tool-call-2", {
          team_name: TEST_TEAM_NAME,
          type: "shutdown_response",
          recipient: "lead",
          content: "Response",
          request_id: "xyz-789",
          approve: true,
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        expect(messageObj).toHaveProperty("requestId", "xyz-789");
      });
    });
  });

  describe("Message Summary", () => {
    describe("Scenario: Message summary provided for UI preview", () => {
      it("Message summary provided for UI preview", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "worker-1",
          content: "This is a very long message that contains more than ten words",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        const summary = messageObj.summary as string;
        const wordCount = summary.split(/\s+/).length;

        expect(wordCount).toBeGreaterThanOrEqual(5);
        expect(wordCount).toBeLessThanOrEqual(10);
        expect(summary).toMatch(/message/);
      });
    });

    describe("Scenario: Summary limited to 5-10 words", () => {
      it("Summary limited to 5-10 words", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "worker-1",
          content:
            "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);
        const summary = messageObj.summary as string;
        const wordCount = summary.split(/\s+/).length;

        expect(wordCount).toBe(10);
        expect(summary).toMatch(/\.\.\.$/);
      });
    });
  });

  describe("Idle Notifications", () => {
    describe("Scenario: Idle notification sent to team lead", () => {
      it("Idle notification sent to team lead", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "worker-4" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "idle",
          recipient: "lead",
          content: "Task completed, going idle",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        expect(filePath).toContain("inbox/lead/messages.jsonl");
      });
    });

    describe("Scenario: Team lead does not auto-respond to idle during shutdown", () => {
      it("Team lead does not auto-respond to idle during shutdown", async () => {
        const leadTool = createSendMessageTool({ agentSessionKey: "lead" });

        await leadTool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "shutdown_request",
          recipient: "worker-4",
          content: "Shutdown requested",
          request_id: "req-shutdown",
        });

        vi.clearAllMocks();
        const workerTool = createSendMessageTool({ agentSessionKey: "worker-4" });

        await workerTool.execute("tool-call-2", {
          team_name: TEST_TEAM_NAME,
          type: "idle",
          recipient: "lead",
          content: "Going idle",
        });

        const allCalls = vi.mocked(fs.appendFile).mock.calls;
        const idleResponses = allCalls.filter((call) => {
          const content = call[1] as string;
          const msgObj = JSON.parse(content);
          return msgObj.type === "message" && msgObj.from === "lead";
        });
        expect(idleResponses).toHaveLength(0);
      });
    });
  });

  describe("Peer DM Visibility", () => {
    describe("Scenario: Peer DM visibility (summary only)", () => {
      it("Peer DM visibility (summary only)", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "worker-a" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "worker-b",
          content: "Hey worker-b, can you help with task #3?",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);

        expect(filePath).toContain("inbox/worker-b/messages.jsonl");
        expect(filePath).not.toContain("inbox/worker-a");
        expect(filePath).not.toContain("inbox/lead");
        expect(messageObj).toHaveProperty("summary");
        expect(messageObj.summary).toMatch(/help/);
      });
    });
  });

  describe("Message Persistence", () => {
    describe("Scenario: Message persists if recipient offline", () => {
      it("Message persists if recipient offline", async () => {
        const tool = createSendMessageTool({ agentSessionKey: "lead" });

        await tool.execute("tool-call-1", {
          team_name: TEST_TEAM_NAME,
          type: "message",
          recipient: "offline-member",
          content: "Message for when you come back online",
        });

        const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
        const filePath = appendCall[0] as string;
        const content = appendCall[1] as string;
        const messageObj = JSON.parse(content);

        expect(filePath).toContain("inbox/offline-member/messages.jsonl");
        expect(messageObj).toHaveProperty("content");
      });
    });

    describe("Scenario: Message queue processed on next inference", () => {
      it("Message queue processed on next inference", async () => {
        const messages = [
          { id: "msg-1", content: "First message" },
          { id: "msg-2", content: "Second message" },
          { id: "msg-3", content: "Third message" },
        ];
        const jsonlContent = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
        vi.mocked(fs.readFile).mockResolvedValue(jsonlContent);

        const pending = await readInboxMessages(TEST_TEAM_NAME, TEST_STATE_DIR, "worker-1");
        expect(pending).toHaveLength(3);
        expect(pending[0]).toHaveProperty("content", "First message");
        expect(pending[1]).toHaveProperty("content", "Second message");
        expect(pending[2]).toHaveProperty("content", "Third message");
      });

      it("Inbox is cleared after processing", async () => {
        vi.mocked(fs.unlink).mockResolvedValue(undefined);
        await clearInboxMessages(TEST_TEAM_NAME, TEST_STATE_DIR, "worker-1");
        expect(vi.mocked(fs.unlink)).toHaveBeenCalled();
      });
    });
  });
});
