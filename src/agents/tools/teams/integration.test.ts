/**
 * Agent Teams Integration Tests
 * Tests the complete flow: team creation, teammate spawning, task management, messaging
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readInboxMessages } from "../../../teams/inbox.js";
import { createSendMessageTool } from "./send-message.js";
import { createTaskClaimTool } from "./task-claim.js";
import { createTaskCompleteTool } from "./task-complete.js";
import { createTaskCreateTool } from "./task-create.js";
import { createTaskListTool } from "./task-list.js";
import { createTeamCreateTool } from "./team-create.js";
import { createTeammateSpawnTool } from "./teammate-spawn.js";

// Mock config for agentToAgent policy
vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    tools: {
      agentToAgent: {
        enabled: true,
        allow: ["*"],
      },
    },
  })),
}));

// Mock Gateway call for session creation
vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ runId: "test-run-id-123" }),
}));

describe("Agent Teams Integration", () => {
  let tempDir: string;
  let leadSessionKey: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create temp directory for team state
    tempDir = mkdtempSync(join(tmpdir(), "agent-teams-integration-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;

    leadSessionKey = "agent:main:user:main";

    // Reset callGateway mock
    const { callGateway } = await import("../../../gateway/call.js");
    (callGateway as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "test-run-id-123" });
  });

  afterEach(() => {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    delete process.env.OPENCLAW_STATE_DIR;
  });

  describe("Team Lifecycle", () => {
    it("should create team and add lead as member", async () => {
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });

      const result = await teamCreateTool.execute("tc-1", {
        team_name: "dev-squad",
        description: "Development squad",
      });

      expect(result.details.teamName).toBe("dev-squad");
      expect(result.details.status).toBe("active");
    });

    it("should spawn teammate with correct session key format", async () => {
      // Create team first
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });
      await teamCreateTool.execute("tc-1", {
        team_name: "key-test-team",
      });

      // Spawn teammate
      const spawnTool = createTeammateSpawnTool({
        agentSessionKey: leadSessionKey,
      });

      const result = await spawnTool.execute("ts-1", {
        team_name: "key-test-team",
        name: "Worker",
        agent_id: "custom-agent",
      });

      // Check the result
      if (result.details.error) {
        // If there's an error, log it for debugging
        console.log("Spawn error:", result.details.error);
      }

      expect(result.details.status).toBe("spawned");
      expect(result.details.sessionKey).toMatch(/^agent:custom-agent:teammate:[a-f0-9-]+$/);
      expect(result.details.teammateId).toMatch(/^[a-f0-9-]+$/);
    });
  });

  describe("Task Management", () => {
    it("should create and list tasks", async () => {
      // Create team
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });
      await teamCreateTool.execute("tc-1", {
        team_name: "task-team",
      });

      // Create task
      const taskCreateTool = createTaskCreateTool();
      const taskResult = await taskCreateTool.execute("tcreate-1", {
        team_name: "task-team",
        subject: "Test Task",
        description: "A test task for verification",
      });

      expect(taskResult.details.status).toBe("pending");
      expect(taskResult.details.taskId).toBeDefined();

      // List tasks
      const listTool = createTaskListTool();
      const listResult = await listTool.execute("tlist-1", {
        team_name: "task-team",
      });

      expect(listResult.details.tasks.length).toBeGreaterThan(0);
      const task = listResult.details.tasks.find(
        (t: { subject: string }) => t.subject === "Test Task",
      );
      expect(task).toBeDefined();
    });

    it("should claim and complete task with announcement", async () => {
      // Create team
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });
      await teamCreateTool.execute("tc-1", {
        team_name: "claim-team",
      });

      // Spawn teammate
      const spawnTool = createTeammateSpawnTool({
        agentSessionKey: leadSessionKey,
      });
      const spawnResult = await spawnTool.execute("ts-1", {
        team_name: "claim-team",
        name: "Worker",
      });
      const workerKey = spawnResult.details.sessionKey;

      // Create task
      const taskCreateTool = createTaskCreateTool();
      const taskResult = await taskCreateTool.execute("tcreate-1", {
        team_name: "claim-team",
        subject: "Work Task",
        description: "A task to be claimed and completed",
      });
      const taskId = taskResult.details.taskId;

      // Claim task as teammate
      const claimTool = createTaskClaimTool({
        agentSessionKey: workerKey,
      });
      const claimResult = await claimTool.execute("tclaim-1", {
        team_name: "claim-team",
        task_id: taskId,
      });

      expect(claimResult.details.status).toBe("claimed");

      // Complete task with announcement
      const completeTool = createTaskCompleteTool({
        agentSessionKey: workerKey,
      });
      const completeResult = await completeTool.execute("tcomp-1", {
        team_name: "claim-team",
        task_id: taskId,
        summary: "Task completed successfully",
        announce: true,
      });

      expect(completeResult.details.status).toBe("completed");
      expect(completeResult.details.announced).toBe(true);

      // Check lead's inbox for announcement
      const inboxMessages = await readInboxMessages("claim-team", tempDir, leadSessionKey);
      const announceMsg = inboxMessages.find((m: { type: string }) => m.type === "task_complete");
      expect(announceMsg).toBeDefined();
      expect(announceMsg.content).toContain("completed");
    });
  });

  describe("Messaging", () => {
    it("should send direct message between teammates", async () => {
      // Create team
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });
      await teamCreateTool.execute("tc-1", {
        team_name: "msg-team",
      });

      // Spawn teammate
      const spawnTool = createTeammateSpawnTool({
        agentSessionKey: leadSessionKey,
      });
      const spawnResult = await spawnTool.execute("ts-1", {
        team_name: "msg-team",
        name: "Worker",
      });
      const workerKey = spawnResult.details.sessionKey;

      // Send message from lead to teammate
      const sendTool = createSendMessageTool({
        agentSessionKey: leadSessionKey,
      });

      const msgResult = await sendTool.execute("sm-1", {
        team_name: "msg-team",
        type: "message",
        recipient: workerKey,
        content: "Hello from the lead!",
      });

      expect(msgResult.details.delivered).toBe(true);

      // Check teammate's inbox
      const inboxMessages = await readInboxMessages("msg-team", tempDir, workerKey);
      expect(inboxMessages.length).toBeGreaterThan(0);
      expect(inboxMessages[0].content).toBe("Hello from the lead!");
    });
  });

  describe("Policy Enforcement", () => {
    it("should enforce agentToAgent policy for cross-agent spawning", async () => {
      const { loadConfig } = await import("../../../config/config.js");

      // Disable agentToAgent
      (loadConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        tools: {
          agentToAgent: {
            enabled: false,
            allow: [],
          },
        },
      });

      // Create team
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });
      await teamCreateTool.execute("tc-1", {
        team_name: "restricted-team",
      });

      // Spawn teammate with different agent
      const spawnTool = createTeammateSpawnTool({
        agentSessionKey: leadSessionKey,
      });

      const spawnResult = await spawnTool.execute("ts-1", {
        team_name: "restricted-team",
        name: "CrossAgentWorker",
        agent_id: "researcher",
      });

      expect(spawnResult.details.error).toContain("denied by tools.agentToAgent policy");
    });
  });

  describe("Error Handling", () => {
    it("should handle spawning into non-existent team", async () => {
      const spawnTool = createTeammateSpawnTool({
        agentSessionKey: leadSessionKey,
      });

      const result = await spawnTool.execute("ts-1", {
        team_name: "non-existent-team",
        name: "Worker",
      });

      expect(result.details.error).toContain("not found");
    });

    it("should handle claiming non-existent task", async () => {
      // Create team
      const teamCreateTool = createTeamCreateTool({
        agentSessionKey: leadSessionKey,
      });
      await teamCreateTool.execute("tc-1", {
        team_name: "error-team",
      });

      const claimTool = createTaskClaimTool({
        agentSessionKey: leadSessionKey,
      });

      const result = await claimTool.execute("tclaim-1", {
        team_name: "error-team",
        task_id: "non-existent-task",
      });

      expect(result.details.error).toBeDefined();
    });
  });
});
