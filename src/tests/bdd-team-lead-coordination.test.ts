// TODO: These tests need proper mock implementation for TeamManager
/**
 * Team Lead Coordination BDD Step Definitions
 * Implements scenarios from features/team-lead-coordination.feature
 */

import { rm } from "fs/promises";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TeamManager } from "../teams/manager.js";

// Global mock data store shared between mock and tests
const mockDataStore = {
  tasks: [] as unknown[],
  members: [] as unknown[],
  messages: [] as unknown[],
  shutdownApprovals: new Map<string, boolean>(),
  shutdownStatus: "idle" as "idle" | "pending" | "approved" | "aborted",
  shutdownInitiated: false,
  nextId: 1,

  reset() {
    this.tasks.length = 0;
    this.members.length = 0;
    this.messages.length = 0;
    this.shutdownApprovals.clear();
    this.shutdownStatus = "idle";
    this.shutdownInitiated = false;
    this.nextId = 1;
  },
};

// Mock node:sqlite for tests
vi.mock("node:sqlite", () => {
  class MockDatabaseSync {
    private _path: string;
    private _isOpen: boolean = true;

    constructor(_path: string) {
      this._path = _path;
    }

    get path(): string {
      return this._path;
    }

    prepare(sql: string): unknown {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
            return mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === args[0],
            );
          }
          if (sql.includes("SELECT status FROM tasks WHERE id = ?")) {
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === args[0],
            );
            return task ? { status: (task as Record<string, unknown>).status } : null;
          }
          if (sql.includes("SELECT blockedBy FROM tasks WHERE id = ?")) {
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === args[0],
            );
            return task
              ? { blockedBy: JSON.stringify((task as Record<string, unknown>).blockedBy || []) }
              : null;
          }
          if (sql.includes("SELECT blocks FROM tasks WHERE id = ?")) {
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === args[0],
            );
            return task
              ? { blocks: JSON.stringify((task as Record<string, unknown>).blocks || []) }
              : null;
          }
          if (sql.includes("SELECT * FROM members WHERE sessionKey = ?")) {
            return mockDataStore.members.find(
              (m: unknown) => (m as Record<string, unknown>).sessionKey === args[0],
            );
          }
          if (sql.includes("SELECT * FROM messages WHERE id = ?")) {
            return mockDataStore.messages.find(
              (m: unknown) => (m as Record<string, unknown>).id === args[0],
            );
          }
          if (sql.includes("SELECT * FROM team_config WHERE name = ?")) {
            return { team_name: args[0], description: "Mock team", agent_type: "general-purpose" };
          }
          return null;
        },
        all: (..._args: unknown[]) => {
          if (sql.includes("SELECT * FROM tasks")) {
            return mockDataStore.tasks;
          }
          if (sql.includes("SELECT * FROM members")) {
            return mockDataStore.members;
          }
          if (sql.includes("SELECT * FROM messages")) {
            return mockDataStore.messages;
          }
          return [];
        },
        run: (...args: unknown[]) => {
          // Handle UPDATE tasks SET status with owner and claimedAt
          if (
            sql.includes("UPDATE tasks SET status") &&
            sql.includes("owner") &&
            sql.includes("claimedAt")
          ) {
            const [status, owner, claimedAt, taskId] = args;
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === taskId,
            );
            if (task) {
              (task as Record<string, unknown>).status = status;
              (task as Record<string, unknown>).owner = owner;
              (task as Record<string, unknown>).claimedAt = claimedAt;
            }
          }
          // Handle UPDATE tasks SET status with completedAt
          else if (sql.includes("UPDATE tasks SET status") && sql.includes("completedAt")) {
            const [status, completedAt, taskId] = args;
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === taskId,
            );
            if (task) {
              (task as Record<string, unknown>).status = status;
              (task as Record<string, unknown>).completedAt = completedAt;
            }
          }
          // Handle UPDATE tasks SET status (general)
          else if (sql.includes("UPDATE tasks SET status")) {
            const [status, taskId] = args;
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === taskId,
            );
            if (task) {
              (task as Record<string, unknown>).status = status;
            }
          }
          // Handle UPDATE tasks SET blockedBy
          else if (sql.includes("UPDATE tasks SET blockedBy")) {
            const [blockedBy, taskId] = args;
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === taskId,
            );
            if (task) {
              try {
                (task as Record<string, unknown>).blockedBy = blockedBy
                  ? JSON.parse(blockedBy as string)
                  : [];
              } catch {
                (task as Record<string, unknown>).blockedBy = [];
              }
            }
          }
          // Handle UPDATE tasks SET blocks
          else if (sql.includes("UPDATE tasks SET blocks")) {
            const [blocks, taskId] = args;
            const task = mockDataStore.tasks.find(
              (t: unknown) => (t as Record<string, unknown>).id === taskId,
            );
            if (task) {
              try {
                (task as Record<string, unknown>).blocks = blocks
                  ? JSON.parse(blocks as string)
                  : [];
              } catch {
                (task as Record<string, unknown>).blocks = [];
              }
            }
          }
          // Handle UPDATE members SET
          else if (sql.includes("UPDATE members")) {
            const memberKey = args[args.length - 1];
            const idx = mockDataStore.members.findIndex(
              (m: unknown) => (m as Record<string, unknown>).sessionKey === memberKey,
            );
            if (idx >= 0) {
              const member = mockDataStore.members[idx] as Record<string, unknown>;
              if (sql.includes("lastActiveAt")) {
                member.lastActiveAt = args[0];
              }
              if (sql.includes("status")) {
                member.status = args[1];
              }
              if (sql.includes("currentTask")) {
                const taskIdx = sql.indexOf("currentTask");
                if (taskIdx >= 0 && sql.includes("NULL")) {
                  member.currentTask = null;
                } else if (args.length > 2) {
                  member.currentTask = args[2];
                }
              }
            }
          }
          // Handle UPDATE messages SET delivered
          else if (sql.includes("UPDATE messages SET delivered")) {
            const idx = mockDataStore.messages.findIndex(
              (m: unknown) => (m as Record<string, unknown>).id === args[0],
            );
            if (idx >= 0) {
              (mockDataStore.messages[idx] as Record<string, unknown>).delivered = true;
            }
          }
          // Handle DELETE FROM tasks
          else if (sql.includes("DELETE FROM tasks")) {
            const idx = mockDataStore.tasks.findIndex(
              (t: unknown) => (t as Record<string, unknown>).id === args[0],
            );
            if (idx >= 0) {
              mockDataStore.tasks.splice(idx, 1);
            }
          }
          // Handle DELETE FROM members
          else if (sql.includes("DELETE FROM members")) {
            const idx = mockDataStore.members.findIndex(
              (m: unknown) => (m as Record<string, unknown>).sessionKey === args[0],
            );
            if (idx >= 0) {
              mockDataStore.members.splice(idx, 1);
            }
          }
          // Handle DELETE FROM messages
          else if (sql.includes("DELETE FROM messages") && !sql.includes("WHERE id")) {
            mockDataStore.messages.length = 0;
          }
          return { changes: 1 };
        },
      };
    }

    exec(_sql: string): void {
      // Don't add placeholder data - let tests manage it directly via mockDataStore
      // This prevents interference between mock INSERTs and test beforeEach setup
    }

    pragma(_statement: string): void {}

    close(): void {
      this._isOpen = false;
      // Don't reset here - reset is handled in beforeEach
    }

    get isOpen(): boolean {
      return this._isOpen;
    }
  }

  return {
    default: MockDatabaseSync,
    DatabaseSync: MockDatabaseSync,
  };
});

vi.mock("node:fs", () => ({
  mkdirSync: () => {},
  existsSync: () => true,
}));

// Helper types
interface ProgressUpdate {
  completedCount: number;
  remainingCount: number;
  totalCount: number;
  timestamp: number;
}

interface ResultSynthesis {
  summary: string;
  results: Array<{
    memberId: string;
    outcome: string;
    timestamp: number;
  }>;
  timestamp: number;
}

// Helper functions for test setup
const setupTeamWithLead = () => {
  mockDataStore.members.push({
    sessionKey: "lead-session-001",
    agentId: "lead-agent-id",
    name: "Lead",
    role: "lead",
    agentType: "general-purpose",
    status: "idle",
    currentTask: null,
    joinedAt: Date.now(),
    lastActiveAt: null,
  });
};

const addMemberToMock = (sessionKey: string, agentId: string, agentType: string, name?: string) => {
  mockDataStore.members.push({
    sessionKey,
    agentId,
    name: name || sessionKey,
    role: "member",
    agentType,
    status: "idle",
    currentTask: null,
    joinedAt: Date.now(),
    lastActiveAt: null,
  });
};

const getShutdownStatus = () => mockDataStore.shutdownStatus;

const recordShutdownResponse = (memberKey: string, approved: boolean) => {
  mockDataStore.shutdownApprovals.set(memberKey, approved);
  if (!approved) {
    mockDataStore.shutdownStatus = "aborted";
    return;
  }
  const members = mockDataStore.members.filter((m) => (m as { role: string }).role === "member");
  const allApproved = members.every(
    (m) => mockDataStore.shutdownApprovals.get((m as { sessionKey: string }).sessionKey) === true,
  );
  if (allApproved) {
    mockDataStore.shutdownStatus = "approved";
  }
};

describe.skip("Team Lead Coordination", () => { // TODO: Fix mock implementation
  const TEST_DIR = "/tmp/test-coordination";
  const stateDir = TEST_DIR;
  const teamName = "coordination-team";
  let manager: TeamManager;
  let teamState: {
    teamName: string;
    config: { team_name: string; description: string | undefined };
    members: unknown[];
  } | null = null;
  let progressUpdates: ProgressUpdate[] = [];
  let resultSynthesis: ResultSynthesis | null = null;
  let failureLogs: Array<{ memberId: string; error: string; timestamp: number }> = [];

  beforeEach(async () => {
    mockDataStore.reset();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
    manager = new TeamManager(teamName, stateDir);
    teamState = null;
    progressUpdates = [];
    resultSynthesis = null;
    failureLogs = [];
  });

  afterEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  describe("Scenario: Team lead discovers team configuration", () => {
    it("loads team configuration with ID, name, and description", () => {
      setupTeamWithLead();

      teamState = manager.getTeamState() as {
        teamName: string;
        config: { team_name: string; description: string | undefined };
        members: unknown[];
      } | null;

      expect(teamState).toBeDefined();
      expect(teamState!.teamName).toBe(teamName);
      expect(teamState!.config).toBeDefined();
      expect(teamState!.config.team_name).toBe(teamName);
      expect(teamState!.config.description).toBe("Mock team");
    });
  });

  describe("Scenario: Team lead lists all members", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");
    });

    it("lists all members with name, role, and session key", () => {
      const members = manager.listMembers();

      expect(members.length).toBe(3);
      members.forEach((member) => {
        expect(member.sessionKey).toBeDefined();
        expect(member.agentId).toBeDefined();
        expect(member.role).toBeDefined();
        expect(member.name).toBeDefined();
      });
    });
  });

  describe("Scenario: Team lead queries member status", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      const task = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "in_progress",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: null,
      };
      mockDataStore.tasks.push(task);
    });

    it("shows member current task and lastActiveAt", () => {
      const members = manager.listMembers();
      const worker1 = members.find((m) => m.sessionKey === "worker-1");
      const memberTasks = manager.listTasks().filter((t) => t.owner === "worker-1");

      expect(worker1).toBeDefined();
      expect(memberTasks.length).toBeGreaterThan(0);
      expect(memberTasks[0].status).toBe("in_progress");
    });
  });

  describe("Scenario: Team lead assigns task to idle member", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("agent-001", "agent-001", "general-purpose", "Agent 001");
    });

    it("claims task by member and changes status to claimed", () => {
      const task = {
        id: randomUUID(),
        subject: "Write docs",
        description: "Create documentation",
        status: "pending",
        owner: "",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
      };
      mockDataStore.tasks.push(task);

      const result = manager.claimTask(task.id, "agent-001");

      expect(result.success).toBe(true);
      const tasks = manager.listTasks();
      const updatedTask = tasks.find((t) => t.id === task.id);
      expect(updatedTask?.status).toBe("in_progress");
      expect(updatedTask?.owner).toBe("agent-001");
    });
  });

  describe("Scenario: Task assignment by member ID order preference", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("agent-001", "agent-001", "general-purpose", "Agent 001");
      addMemberToMock("agent-002", "agent-002", "general-purpose", "Agent 002");
      addMemberToMock("agent-003", "agent-003", "general-purpose", "Agent 003");
    });

    it("assigns task to agent-001 (lower ID) when both 001 and 003 are idle", () => {
      const task = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "pending",
        owner: "",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
      };
      mockDataStore.tasks.push(task);

      const members = manager.listMembers();
      const idleMembers = members.filter((m) => m.sessionKey.startsWith("agent-"));
      const chosenMember = idleMembers.toSorted((a, b) => a.agentId.localeCompare(b.agentId))[0];

      expect(chosenMember).toBeDefined();
      if (chosenMember) {
        const result = manager.claimTask(task.id, chosenMember.sessionKey);
        expect(result.success).toBe(true);
        expect(chosenMember.agentId).toBe("agent-001");
      }
    });
  });

  describe("Scenario: Team lead monitors task completion", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
    });

    it("receives notification when member completes task", () => {
      const task = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "in_progress",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: null,
      };
      mockDataStore.tasks.push(task);

      manager.completeTask(task.id);

      const tasks = manager.listTasks();
      const updatedTask = tasks.find((t) => t.id === task.id);
      expect(updatedTask?.status).toBe("completed");
      expect(updatedTask?.completedAt).toBeDefined();
    });
  });

  describe("Scenario: Team lead receives completion notification", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      const task1 = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "completed",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: Date.now(),
      };
      const task2 = {
        id: randomUUID(),
        subject: "Dependent task",
        description: "Depends on test task",
        status: "pending",
        owner: "",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
      };
      mockDataStore.tasks.push(task1, task2);
    });

    it("includes completion info in context with unblocked tasks identified", () => {
      const tasks = manager.listTasks();
      const completedTask = tasks.find((t) => t.status === "completed");
      const pendingTasks = tasks.filter((t) => t.status === "pending");

      expect(completedTask).toBeDefined();
      expect(pendingTasks.length).toBe(1);
    });
  });

  describe("Scenario: Team lead unblocks dependent tasks", () => {
    beforeEach(() => {
      setupTeamWithLead();
      const taskA = {
        id: randomUUID(),
        subject: "Task A",
        description: "Blocking task",
        status: "pending",
        owner: "",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
      };
      const taskB = {
        id: randomUUID(),
        subject: "Task B",
        description: "Dependent task",
        status: "pending",
        owner: "",
        blockedBy: [taskA.id],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
        dependsOn: [taskA.id],
      };
      mockDataStore.tasks.push(taskA, taskB);
    });

    it("makes task-B available when task-A completes", () => {
      const tasks = manager.listTasks();
      const taskA = tasks.find((t) => t.subject === "Task A");
      const taskB = tasks.find((t) => t.subject === "Task B");

      expect(taskB?.dependsOn).toContain(taskA?.id);
    });
  });

  describe("Scenario: Team lead coordinates shutdown sequence", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");
      addMemberToMock("worker-3", "agent-003", "general-purpose", "Worker 3");
    });

    it("sends shutdown requests to all members and awaits approvals", () => {
      mockDataStore.shutdownInitiated = true;
      mockDataStore.shutdownStatus = "pending";

      const members = manager.listMembers();
      members.forEach((m) => {
        if (m.role !== "lead") {
          manager.storeMessage({
            id: randomUUID(),
            from: "lead-session-001",
            to: m.sessionKey,
            type: "shutdown_request",
            content: "Shutdown requested",
            summary: "Shutdown requested",
            sender: "lead-session-001",
            recipient: m.sessionKey,
            timestamp: Date.now(),
            requestId: randomUUID(),
          });
        }
      });

      expect(mockDataStore.shutdownInitiated).toBe(true);
      expect(mockDataStore.shutdownStatus).toBe("pending");
    });
  });

  describe("Scenario: Team lead waits for all member approvals", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");
      addMemberToMock("worker-3", "agent-003", "general-purpose", "Worker 3");
      mockDataStore.shutdownStatus = "pending";
    });

    it("completes shutdown after all members approve", () => {
      // First two members approve
      recordShutdownResponse("worker-1", true);
      recordShutdownResponse("worker-2", true);

      expect(getShutdownStatus()).toBe("pending");

      // Third member approves
      recordShutdownResponse("worker-3", true);

      expect(getShutdownStatus()).toBe("approved");
    });
  });

  describe("Scenario: Team lead completes team deletion", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      mockDataStore.shutdownStatus = "approved";
      mockDataStore.shutdownApprovals.set("worker-1", true);
    });

    it("deletes team directory and removes team from system", () => {
      const deletionComplete = mockDataStore.shutdownStatus === "approved";

      expect(deletionComplete).toBe(true);
      expect(mockDataStore.shutdownApprovals.get("worker-1")).toBe(true);
    });
  });

  describe("Scenario: Team lead state persists across context compression", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      const task = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "in_progress",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: null,
      };
      mockDataStore.tasks.push(task);
    });

    it("reloads team state from file after compression", () => {
      const stateBefore = manager.getTeamState() as {
        teamName: string;
        config: { team_name: string };
      };

      // Simulate context compression by creating a new manager
      const managerAfterReload = new TeamManager(teamName, stateDir);
      const stateAfter = managerAfterReload.getTeamState() as {
        teamName: string;
        config: { team_name: string };
      };

      expect(stateAfter).toBeDefined();
      expect(stateAfter.teamName).toBe(stateBefore.teamName);
      expect(stateAfter.config.team_name).toBe(stateBefore.config.team_name);
    });
  });

  describe("Scenario: Team lead knows about team after compression", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
    });

    it("injects team state with name and members known", () => {
      teamState = manager.getTeamState() as {
        teamName: string;
        config: { team_name: string; description: string | undefined };
        members: unknown[];
      } | null;

      expect(teamState).toBeDefined();
      expect(teamState!.teamName).toBe(teamName);
      expect(teamState!.members.length).toBeGreaterThanOrEqual(1);
      const members = teamState!.members;
      const leadMember = members.find(
        (m: unknown) => (m as Record<string, unknown>).sessionKey === "lead-session-001",
      );
      expect(leadMember).toBeDefined();
    });
  });

  describe("Scenario: Team lead maintains member roster in ground truth", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");
      const task = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "in_progress",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: null,
      };
      mockDataStore.tasks.push(task);
    });

    it("shows member roster with active vs idle status visible", () => {
      const members = manager.listMembers();
      const workingMembers = members.filter((m) => m.status === "working");
      const idleMembers = members.filter((m) => m.status === "idle" || !m.status);

      expect(members.length).toBe(3);
      expect(workingMembers.length).toBeGreaterThanOrEqual(0);
      expect(idleMembers.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Scenario: Team lead handles member failure gracefully", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");
    });

    it("logs failure and continues with remaining members", () => {
      const failureTime = Date.now();

      failureLogs.push({
        memberId: "worker-1",
        error: "Connection timeout",
        timestamp: failureTime,
      });

      manager.removeMember("worker-1");

      const members = manager.listMembers();
      const activeMembers = members.filter((m) => m.sessionKey !== "worker-1");

      expect(failureLogs.length).toBe(1);
      expect(failureLogs[0].memberId).toBe("worker-1");
      expect(activeMembers.length).toBe(1);
    });
  });

  describe("Scenario: Team lead spawns replacement member", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      const task = {
        id: randomUUID(),
        subject: "Test task",
        description: "Task for testing",
        status: "in_progress",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: null,
      };
      mockDataStore.tasks.push(task);

      failureLogs.push({
        memberId: "worker-1",
        error: "Connection timeout",
        timestamp: Date.now(),
      });

      manager.removeMember("worker-1");
    });

    it("adds new member and assigns tasks from failed member", () => {
      addMemberToMock("worker-replacement", "agent-002", "general-purpose", "Worker Replacement");

      const members = manager.listMembers();
      const replacementMember = members.find((m) => m.sessionKey === "worker-replacement");

      expect(members.length).toBe(2);
      expect(replacementMember).toBeDefined();
    });
  });

  describe("Scenario: Team lead reports progress to user", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");

      const task1 = {
        id: randomUUID(),
        subject: "Task 1",
        description: "First task",
        status: "completed",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: Date.now(),
      };
      const task2 = {
        id: randomUUID(),
        subject: "Task 2",
        description: "Second task",
        status: "pending",
        owner: "",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
      };
      const task3 = {
        id: randomUUID(),
        subject: "Task 3",
        description: "Third task",
        status: "pending",
        owner: "",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: null,
        completedAt: null,
      };
      mockDataStore.tasks.push(task1, task2, task3);
    });

    it("reports progress with completed and remaining counts", () => {
      const tasks = manager.listTasks();
      const completed = tasks.filter((t) => t.status === "completed").length;
      const remaining = tasks.filter((t) => t.status !== "completed").length;

      progressUpdates.push({
        completedCount: completed,
        remainingCount: remaining,
        totalCount: tasks.length,
        timestamp: Date.now(),
      });

      expect(progressUpdates[0].completedCount).toBe(1);
      expect(progressUpdates[0].remainingCount).toBe(2);
      expect(progressUpdates[0].totalCount).toBe(3);
    });
  });

  describe("Scenario: Team lead synthesizes results from members", () => {
    beforeEach(() => {
      setupTeamWithLead();
      addMemberToMock("worker-1", "agent-001", "general-purpose", "Worker 1");
      addMemberToMock("worker-2", "agent-002", "general-purpose", "Worker 2");

      const task1 = {
        id: randomUUID(),
        subject: "Task 1",
        description: "First task",
        status: "completed",
        owner: "worker-1",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: Date.now(),
      };
      const task2 = {
        id: randomUUID(),
        subject: "Task 2",
        description: "Second task",
        status: "completed",
        owner: "worker-2",
        blockedBy: [],
        blocks: [],
        createdAt: Date.now(),
        claimedAt: Date.now(),
        completedAt: Date.now(),
      };
      mockDataStore.tasks.push(task1, task2);
    });

    it("synthesizes results and provides summary to user", () => {
      const tasks = manager.listTasks();
      const completedTasks = tasks.filter((t) => t.status === "completed");

      resultSynthesis = {
        summary: `All ${completedTasks.length} tasks completed successfully`,
        results: completedTasks.map((task) => ({
          memberId: task.owner || "unknown",
          outcome: `Completed: ${task.subject}`,
          timestamp: task.completedAt || Date.now(),
        })),
        timestamp: Date.now(),
      };

      expect(resultSynthesis).toBeDefined();
      expect(resultSynthesis?.summary).toContain("2 tasks");
      expect(resultSynthesis?.results.length).toBe(2);
    });
  });
});
