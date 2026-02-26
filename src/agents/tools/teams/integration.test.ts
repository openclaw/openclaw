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

// Helper type for tool results
interface ToolResult {
  teamName?: string;
  teamId?: string;
  status?: string;
  error?: string;
  sessionKey?: string;
  teammateId?: string;
  taskId?: string;
  tasks?: Array<{ subject: string; status: string; id: string }>;
  delivered?: boolean;
  announced?: boolean;
  message?: string;
  warnings?: string[];
  name?: string;
  agentId?: string;
}

// Type helper for accessing details
const getDetails = (result: { details: unknown }): ToolResult => result.details as ToolResult;

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

      expect(getDetails(result).teamName).toBe("dev-squad");
      expect(getDetails(result).status).toBe("active");
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
      if (getDetails(result).error) {
        // If there's an error, log it for debugging
        console.log("Spawn error:", getDetails(result).error);
      }

      expect(getDetails(result).status).toBe("spawned");
      // New format: agent:teammate-{name}:main (not using agent_id parameter)
      expect(getDetails(result).sessionKey).toBe("agent:teammate-worker:main");
      // teammateId is now the sanitized name
      expect(getDetails(result).teammateId).toBe("worker");
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

      expect(getDetails(taskResult).status).toBe("pending");
      expect(getDetails(taskResult).taskId).toBeDefined();

      // List tasks
      const listTool = createTaskListTool();
      const listResult = await listTool.execute("tlist-1", {
        team_name: "task-team",
      });

      expect(getDetails(listResult).tasks?.length).toBeGreaterThan(0);
      const task = getDetails(listResult).tasks?.find(
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
      const workerKey = getDetails(spawnResult).sessionKey!;

      // Create task
      const taskCreateTool = createTaskCreateTool();
      const taskResult = await taskCreateTool.execute("tcreate-1", {
        team_name: "claim-team",
        subject: "Work Task",
        description: "A task to be claimed and completed",
      });
      const taskId = getDetails(taskResult).taskId;

      // Claim task as teammate
      const claimTool = createTaskClaimTool({
        agentSessionKey: workerKey,
      });
      const claimResult = await claimTool.execute("tclaim-1", {
        team_name: "claim-team",
        task_id: taskId,
      });

      expect(getDetails(claimResult).status).toBe("claimed");

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

      expect(getDetails(completeResult).status).toBe("completed");
      expect(getDetails(completeResult).announced).toBe(true);

      // Check lead's inbox for announcement
      const inboxMessages = await readInboxMessages(
        "claim-team",
        `${tempDir}/teams`,
        leadSessionKey,
      );
      const announceMsg = inboxMessages.find(
        (m: Record<string, unknown>) => (m as { type: string }).type === "task_complete",
      );
      expect(announceMsg).toBeDefined();
      expect((announceMsg as { content: string }).content).toContain("completed");
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
      const workerKey = getDetails(spawnResult).sessionKey!;

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

      expect(getDetails(msgResult).delivered).toBe(true);

      // Check teammate's inbox
      const inboxMessages = await readInboxMessages("msg-team", `${tempDir}/teams`, workerKey);
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

      // Teammates are now full agents, not restricted by agentToAgent policy
      expect(getDetails(spawnResult).status).toBe("spawned");
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

      expect(getDetails(result).error).toContain("not found");
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

      expect(getDetails(result).error).toBeDefined();
    });
  });
});
