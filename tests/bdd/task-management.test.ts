// TODO: These tests need proper mock implementation for TeamManager
/**
 * Task Management BDD Step Definitions
 * Implements scenarios from features/task-management.feature
 * Based on OpenClaw Agent Teams Design (2026-02-23)
 */

import { rm } from "fs/promises";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TeamManager } from "../../src/teams/manager.js";
import type { TaskWithComputed, TaskClaimResult } from "../../src/teams/manager.js";

// Test context for BDD scenarios
interface BddContext {
  manager: TeamManager;
  stateDir: string;
  teamName: string;
  createdTaskIds: string[];
  currentSession: string;
  results: Record<string, unknown>;
}

// Mock node:sqlite for tests
vi.mock("node:sqlite", () => {
  let mockTasks: TaskWithComputed[] = [];
  let nextId = 1;

  class MockDatabaseSync {
    private _path: string;
    private _isOpen: boolean = true;

    constructor(path: string) {
      this._path = path;
    }

    get path(): string {
      return this._path;
    }

    prepare(sql: string): unknown {
      return {
        get: (...args: unknown[]) => {
          if (sql.includes("SELECT * FROM tasks WHERE id = ?")) {
            return mockTasks.find((t: TaskWithComputed) => t.id === args[0]);
          }
          if (sql.includes("SELECT status FROM tasks WHERE id = ?")) {
            const task = mockTasks.find((t: TaskWithComputed) => t.id === args[0]);
            return task ? { status: task.status } : null;
          }
          if (sql.includes("SELECT blockedBy FROM tasks WHERE id = ?")) {
            const task = mockTasks.find((t: TaskWithComputed) => t.id === args[0]);
            return task ? { blockedBy: JSON.stringify(task.blockedBy || []) } : null;
          }
          if (sql.includes("SELECT blocks FROM tasks WHERE id = ?")) {
            const task = mockTasks.find((t: TaskWithComputed) => t.id === args[0]);
            return task ? { blocks: JSON.stringify(task.blocks || []) } : null;
          }
          return null;
        },
        all: () => mockTasks,
        run: (...args: unknown[]) => {
          if (sql.includes("UPDATE tasks SET status")) {
            const [status, owner, claimedAt, completedAt, taskId] = args;
            const task = mockTasks.find((t: TaskWithComputed) => t.id === taskId);
            if (task) {
              task.status = status;
              task.owner = owner;
              task.claimedAt = claimedAt;
              task.completedAt = completedAt;
            }
          }
          if (sql.includes("UPDATE tasks SET blockedBy")) {
            const [blockedBy, taskId] = args;
            const task = mockTasks.find((t: TaskWithComputed) => t.id === taskId);
            if (task) {
              task.blockedBy = JSON.parse(blockedBy || "[]");
            }
          }
          if (sql.includes("UPDATE tasks SET blocks")) {
            const [blocks, taskId] = args;
            const task = mockTasks.find((t: TaskWithComputed) => t.id === taskId);
            if (task) {
              task.blocks = JSON.parse(blocks || "[]");
            }
          }
          return { changes: 1 };
        },
      };
    }

    exec(sql: string): void {
      if (sql.includes("INSERT INTO tasks")) {
        const valuesRegex = /VALUES \(([^)]+)\)/;
        const match = sql.match(valuesRegex);
        if (match && match[1]) {
          const parts = match[1]
            .split(",")
            .map((p) => p.trim().replace(/^'/, "").replace(/'$/, ""));
          const task: TaskWithComputed = {
            id: parts[0] || `task-${nextId++}`,
            subject: parts[1] || "",
            description: parts[2] || "",
            activeForm: parts[3] === "NULL" ? undefined : parts[3],
            status: (parts[4] || "pending") as TaskWithComputed["status"],
            owner: parts[5] === "NULL" ? "" : parts[5],
            dependsOn: parts[6] === "NULL" ? undefined : JSON.parse(parts[6] || "[]"),
            blockedBy: parts[7] === "NULL" ? [] : JSON.parse(parts[7] || "[]"),
            blocks: parts[8] === "NULL" ? [] : JSON.parse(parts[8] || "[]"),
            metadata: parts[9] === "NULL" ? undefined : JSON.parse(parts[9] || "null"),
            createdAt: Date.now(),
            claimedAt: undefined,
            completedAt: undefined,
          };
          mockTasks.push(task);
        }
      }
    }

    pragma(_statement: string): void {}

    close(): void {
      this._isOpen = false;
      mockTasks = [];
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

// Helper functions for BDD step definitions

function createTestContext(): BddContext {
  const TEST_DIR = `/tmp/test-tasks-${randomUUID()}`;
  const teamName = "task-team";
  return {
    stateDir: TEST_DIR,
    teamName,
    manager: new TeamManager(teamName, TEST_DIR),
    createdTaskIds: [],
    currentSession: "test-session",
    results: {},
  };
}

function cleanupContext(ctx: BddContext): void {
  ctx.manager.close();
  rm(ctx.stateDir, { recursive: true, force: true }).catch(() => {});
}

describe.skip("Task Management BDD", () => { // TODO: Fix mock implementation
  // Background steps
  describe("Background: Team setup", () => {
    it("state directory and team exist", () => {
      const ctx = createTestContext();
      expect(ctx.stateDir === "/tmp/test-tasks/" || ctx.stateDir.startsWith("/tmp/test-")).toBe(
        true,
      );
      expect(ctx.teamName).toBe("task-team");
      cleanupContext(ctx);
    });
  });

  // Scenario 1: Add a single task to the team
  describe("Scenario: Add a single task to the team", () => {
    let ctx: BddContext;
    let taskId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('When TaskCreate tool is called with subject "Write docs" and description "Create documentation"', () => {
      taskId = ctx.manager.createTask("Write docs", "Create documentation").id;
      ctx.createdTaskIds.push(taskId);
      expect(taskId).toBeDefined();
    });

    it("Then task is added to ledger", () => {
      const tasks = ctx.manager.listTasks();
      expect(tasks.length).toBeGreaterThan(0);
      const task = tasks.find((t) => t.id === taskId);
      expect(task).toBeDefined();
    });

    it("And task ID is returned", () => {
      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe("string");
    });
  });

  // Scenario 2: Add a task with active form
  describe("Scenario: Add a task with active form", () => {
    let ctx: BddContext;
    let taskId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('When TaskCreate tool is called with subject "Test API" and activeForm "Testing API endpoints"', () => {
      const task = ctx.manager.createTask("Test API", "Test the API endpoints", {
        activeForm: "Testing API endpoints",
      });
      taskId = task.id;
      expect(taskId).toBeDefined();
    });

    it("Then active form is stored in task", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.activeForm).toBe("Testing API endpoints");
    });
  });

  // Scenario 3: Add task with metadata
  describe("Scenario: Add task with metadata", () => {
    let ctx: BddContext;
    let taskId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('When TaskCreate tool is called with subject "Fix bug" and metadata {"priority": "high"}', () => {
      const metadata = { priority: "high", severity: "critical" };
      const task = ctx.manager.createTask("Fix bug", "Fix the critical bug", { metadata });
      taskId = task.id;
      expect(taskId).toBeDefined();
    });

    it("Then metadata is stored as JSON in task", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.metadata).toEqual({ priority: "high", severity: "critical" });
    });
  });

  // Scenario 4: List all tasks in the team
  describe("Scenario: List all tasks in the team", () => {
    let ctx: BddContext;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given team has multiple tasks", () => {
      ctx.manager.createTask("Task 1", "First task");
      ctx.manager.createTask("Task 2", "Second task");
      ctx.manager.createTask("Task 3", "Third task");
      const tasks = ctx.manager.listTasks();
      expect(tasks.length).toBe(3);
    });

    it("When TaskList tool is called without filters", () => {
      const tasks = ctx.manager.listTasks();
      ctx.results.allTasks = tasks;
      expect(tasks.length).toBe(3);
    });

    it("Then all tasks are returned", () => {
      const tasks = ctx.results.allTasks as TaskWithComputed[];
      expect(tasks.length).toBe(3);
    });

    it("And tasks are sorted by createdAt descending", () => {
      const tasks = ctx.results.allTasks as TaskWithComputed[];
      for (let i = 1; i < tasks.length; i++) {
        expect(tasks[i].createdAt).toBeLessThanOrEqual(tasks[i - 1].createdAt);
      }
    });
  });

  // Scenario 5: List only pending tasks
  describe("Scenario: List only pending tasks", () => {
    let ctx: BddContext;
    let pendingTaskId: string;
    let completedTaskId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given team has tasks in various statuses", () => {
      pendingTaskId = ctx.manager.createTask("Pending task", "Task to do").id;
      const inProgressId = ctx.manager.createTask("In progress task", "Task being done").id;
      completedTaskId = ctx.manager.createTask("Completed task", "Done task").id;

      ctx.manager.claimTask(inProgressId, "session-1");
      ctx.manager.claimTask(completedTaskId, "session-1");
      ctx.manager.completeTask(completedTaskId);
    });

    it('When TaskList tool is called with status: "pending"', () => {
      const tasks = ctx.manager.listTasks();
      ctx.results.pendingTasks = tasks.filter((t) => t.status === "pending");
    });

    it("Then only pending tasks are returned", () => {
      const pendingTasks = ctx.results.pendingTasks as TaskWithComputed[];
      expect(pendingTasks.length).toBe(1);
      expect(pendingTasks[0].id).toBe(pendingTaskId);
      expect(pendingTasks.every((t) => t.status === "pending")).toBe(true);
    });
  });

  // Scenario 6: Claim an available task
  describe("Scenario: Claim an available task", () => {
    let ctx: BddContext;
    let taskId: string;
    const sessionId = "agent-session-1";

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('Given task with ID "task-1" has status pending', () => {
      taskId = ctx.manager.createTask("Test task", "Task for testing").id;
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.status).toBe("pending");
    });

    it('When TaskClaim tool is called with task_id: "task-1"', () => {
      const result = ctx.manager.claimTask(taskId, sessionId);
      ctx.results.claimResult = result;
    });

    it("Then task status changes to claimed", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.status).toBe("in_progress");
    });

    it("And task owner is set to claiming session", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.owner).toBe(sessionId);
    });

    it("And claimedAt timestamp is set", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.claimedAt).toBeDefined();
      expect(task?.claimedAt).toBeGreaterThan(0);
    });
  });

  // Scenario 7: Claim task updates active form
  describe("Scenario: Claim task updates active form", () => {
    let ctx: BddContext;
    let taskId: string;
    const activeForm = "Fixing critical authentication bug";

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given task has activeForm defined", () => {
      const task = ctx.manager.createTask("Fix auth bug", "Fix authentication", { activeForm });
      taskId = task.id;
      expect(task.activeForm).toBe(activeForm);
    });

    it("When task is claimed", () => {
      ctx.manager.claimTask(taskId, "agent-session");
    });

    it("Then active form is applied to task display", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.activeForm).toBe(activeForm);
      expect(task?.status).toBe("in_progress");
    });
  });

  // Scenario 8: Attempt to claim already claimed task
  describe("Scenario: Attempt to claim already claimed task", () => {
    let ctx: BddContext;
    let taskId: string;
    const sessionA = "session-a";
    const sessionB = "session-b";

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('Given task "task-1" is already claimed by "session-a"', () => {
      taskId = ctx.manager.createTask("Test task", "Task for testing").id;
      const firstResult = ctx.manager.claimTask(taskId, sessionA);
      expect(firstResult.success).toBe(true);
    });

    it('When TaskClaim tool is called for "session-b"', () => {
      const result = ctx.manager.claimTask(taskId, sessionB);
      ctx.results.secondClaim = result;
    });

    it("Then claim returns conflict error", () => {
      const result = ctx.results.secondClaim as TaskClaimResult;
      expect(result.success).toBe(false);
      expect(result.reason).toContain("already claimed");
    });

    it("And task ownership remains unchanged", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.owner).toBe(sessionA);
      expect(task?.owner).not.toBe(sessionB);
    });
  });

  // Scenario 9: Atomic task claiming prevents race conditions
  describe("Scenario: Atomic task claiming prevents race conditions", () => {
    let ctx: BddContext;
    let taskId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('Given pending task with ID "task-5"', () => {
      taskId = ctx.manager.createTask("Shared task", "Task to be claimed").id;
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.status).toBe("pending");
    });

    it('And two idle members "agent-fast" and "agent-slow"', () => {
      ctx.currentSession = "agent-fast";
      const otherSession = "agent-slow";
      expect(ctx.currentSession).toBe("agent-fast");
      expect(otherSession).toBe("agent-slow");
    });

    it("When both members attempt to claim task simultaneously", () => {
      const agentFast = ctx.manager.claimTask(taskId, "agent-fast");
      const agentSlow = ctx.manager.claimTask(taskId, "agent-slow");
      ctx.results.agentFastClaim = agentFast;
      ctx.results.agentSlowClaim = agentSlow;
    });

    it("Then only one member successfully claims task", () => {
      const fastResult = ctx.results.agentFastClaim as TaskClaimResult;
      const slowResult = ctx.results.agentSlowClaim as TaskClaimResult;
      const successCount = [fastResult, slowResult].filter((r) => r.success).length;
      expect(successCount).toBe(1);
    });

    it("And other member receives conflict error", () => {
      const fastResult = ctx.results.agentFastClaim as TaskClaimResult;
      const slowResult = ctx.results.agentSlowClaim as TaskClaimResult;
      const failedClaim = fastResult.success ? slowResult : fastResult;
      expect(failedClaim.success).toBe(false);
      expect(failedClaim.reason).toContain("already claimed");
    });

    it("And task has exactly one owner assigned", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.owner).toBeDefined();
      expect(task?.owner !== "").toBe(true);
      const isAgentFast = task?.owner === "agent-fast";
      const isAgentSlow = task?.owner === "agent-slow";
      expect(isAgentFast || isAgentSlow).toBe(true);
    });
  });

  // Scenario 10: Mark task as completed
  describe("Scenario: Mark task as completed", () => {
    let ctx: BddContext;
    let taskId: string;
    const sessionId = "agent-session-1";

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('Given task "task-2" is claimed by session', () => {
      taskId = ctx.manager.createTask("Test task", "Task for testing").id;
      ctx.manager.claimTask(taskId, sessionId);
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.owner).toBe(sessionId);
    });

    it("When TaskComplete tool is called", () => {
      const result = ctx.manager.completeTask(taskId);
      ctx.results.completeResult = result;
    });

    it("Then task status changes to completed", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.status).toBe("completed");
    });

    it("And completedAt timestamp is set", () => {
      const tasks = ctx.manager.listTasks();
      const task = tasks.find((t) => t.id === taskId);
      expect(task?.completedAt).toBeDefined();
      expect(task?.completedAt).toBeGreaterThan(0);
    });
  });

  // Scenario 11: Add task with dependencies
  describe("Scenario: Add task with dependencies", () => {
    let ctx: BddContext;
    let taskAId: string;
    let taskBId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('Given task "task-a" already exists', () => {
      taskAId = ctx.manager.createTask("Task A", "First task").id;
      const tasks = ctx.manager.listTasks();
      expect(tasks.some((t) => t.id === taskAId)).toBe(true);
    });

    it('When TaskCreate is called with dependsOn: ["task-a"]', () => {
      const taskB = ctx.manager.createTask("Task B", "Task depending on A");
      taskBId = taskB.id;
      ctx.manager.addTaskDependency(taskBId, taskAId);
    });

    it("Then new task has dependsOn set", () => {
      const tasks = ctx.manager.listTasks();
      const taskB = tasks.find((t) => t.id === taskBId);
      expect(taskB?.dependsOn).toContain(taskAId);
    });

    it('And new task has blockedBy set to ["task-a"]', () => {
      const tasks = ctx.manager.listTasks();
      const taskB = tasks.find((t) => t.id === taskBId);
      expect(taskB?.blockedBy).toContain(taskAId);
    });

    it("And new task status is pending", () => {
      const tasks = ctx.manager.listTasks();
      const taskB = tasks.find((t) => t.id === taskBId);
      expect(taskB?.status).toBe("pending");
    });
  });

  // Scenario 12: List tasks blocked by dependencies
  describe("Scenario: List tasks blocked by dependencies", () => {
    let ctx: BddContext;
    let blockedTaskId: string;
    let independentTaskId: string;
    let completedDependencyId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given tasks with various dependency states", () => {
      // Completed dependency
      completedDependencyId = ctx.manager.createTask("Completed dep", "Finished task").id;
      ctx.manager.claimTask(completedDependencyId, "session-1");
      ctx.manager.completeTask(completedDependencyId);

      // Independent task (no dependencies)
      independentTaskId = ctx.manager.createTask("Independent task", "No dependencies").id;

      // Blocked task with active dependency
      const activeDependencyId = ctx.manager.createTask("Active dep", "Running task").id;
      ctx.manager.claimTask(activeDependencyId, "session-2");

      blockedTaskId = ctx.manager.createTask("Blocked task", "Has active dependency").id;
      ctx.manager.addTaskDependency(blockedTaskId, activeDependencyId);
    });

    it("When TaskList is called", () => {
      const tasks = ctx.manager.listTasks();
      ctx.results.allTasks = tasks;
    });

    it("Then blocked tasks are identified correctly", () => {
      const tasks = ctx.results.allTasks as TaskWithComputed[];
      const blockedTasks = tasks.filter((t) => t.blockedBy && t.blockedBy.length > 0);
      expect(blockedTasks.length).toBe(1);
      expect(blockedTasks[0].id).toBe(blockedTaskId);
    });

    it("And blockedBy array reflects actual dependencies", () => {
      const tasks = ctx.results.allTasks as TaskWithComputed[];
      const blockedTask = tasks.find((t) => t.id === blockedTaskId);
      expect(blockedTask?.blockedBy?.length).toBeGreaterThan(0);
      const independentTask = tasks.find((t) => t.id === independentTaskId);
      expect(independentTask?.blockedBy?.length).toBe(0);
    });
  });

  // Scenario 13: Auto-unblock tasks when dependency completes
  describe("Scenario: Auto-unblock tasks when dependency completes", () => {
    let ctx: BddContext;
    let taskXId: string;
    let taskYId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it('Given task "task-x" depends on "task-y"', () => {
      taskYId = ctx.manager.createTask("Task Y", "Blocking task").id;
      taskXId = ctx.manager.createTask("Task X", "Dependent task").id;
      ctx.manager.addTaskDependency(taskXId, taskYId);
    });

    it('And "task-x" is blocked with status pending', () => {
      const tasks = ctx.manager.listTasks();
      const taskX = tasks.find((t) => t.id === taskXId);
      expect(taskX?.status).toBe("pending");
      expect(taskX?.blockedBy).toContain(taskYId);
    });

    it('When "task-y" is marked as completed', () => {
      ctx.manager.claimTask(taskYId, "session-1");
      ctx.manager.completeTask(taskYId);
    });

    it('Then "task-x" is removed from blockedBy', () => {
      const tasks = ctx.manager.listTasks();
      const taskX = tasks.find((t) => t.id === taskXId);
      expect(taskX?.blockedBy).not.toContain(taskYId);
    });

    it('And "task-x" status changes to pending (available)', () => {
      const tasks = ctx.manager.listTasks();
      const taskX = tasks.find((t) => t.id === taskXId);
      expect(taskX?.status).toBe("pending");
      expect(taskX?.blockedBy?.length).toBe(0);
    });
  });

  // Scenario 14: Complex dependency chain resolution
  describe("Scenario: Complex dependency chain resolution", () => {
    let ctx: BddContext;
    let task1Id: string;
    let task2Id: string;
    let task3Id: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given tasks: task-1 -> task-2 -> task-3 (depends on)", () => {
      task1Id = ctx.manager.createTask("Task 1", "First in chain").id;
      task2Id = ctx.manager.createTask("Task 2", "Depends on task 1").id;
      task3Id = ctx.manager.createTask("Task 3", "Depends on task 2").id;

      ctx.manager.addTaskDependency(task2Id, task1Id);
      ctx.manager.addTaskDependency(task3Id, task2Id);
    });

    it("And all tasks are blocked", () => {
      const tasks = ctx.manager.listTasks();
      const task1 = tasks.find((t) => t.id === task1Id);
      const task2 = tasks.find((t) => t.id === task2Id);
      const task3 = tasks.find((t) => t.id === task3Id);

      expect(task1?.blockedBy?.length).toBe(0);
      expect(task2?.blockedBy).toContain(task1Id);
      expect(task3?.blockedBy).toContain(task2Id);
    });

    it("When task-1 is completed", () => {
      ctx.manager.claimTask(task1Id, "session-1");
      ctx.manager.completeTask(task1Id);
    });

    it("Then task-2 is unblocked", () => {
      const tasks = ctx.manager.listTasks();
      const task2 = tasks.find((t) => t.id === task2Id);
      expect(task2?.blockedBy).not.toContain(task1Id);
      expect(task2?.blockedBy?.length).toBe(0);
    });

    it("And task-3 remains blocked", () => {
      const tasks = ctx.manager.listTasks();
      const task3 = tasks.find((t) => t.id === task3Id);
      expect(task3?.blockedBy).toContain(task2Id);
    });

    it("When task-2 is completed", () => {
      ctx.manager.claimTask(task2Id, "session-1");
      ctx.manager.completeTask(task2Id);
    });

    it("Then task-3 is unblocked", () => {
      const tasks = ctx.manager.listTasks();
      const task3 = tasks.find((t) => t.id === task3Id);
      expect(task3?.blockedBy).not.toContain(task2Id);
      expect(task3?.blockedBy?.length).toBe(0);
    });
  });

  // Scenario 15: Circular dependency detection and prevention
  describe("Scenario: Circular dependency detection and prevention", () => {
    let ctx: BddContext;
    let taskAId: string;
    let taskBId: string;
    let taskCId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given task-A already exists", () => {
      taskAId = ctx.manager.createTask("Task A", "First task").id;
    });

    it("And task-B depends on task-A", () => {
      taskBId = ctx.manager.createTask("Task B", "Depends on A").id;
      ctx.manager.addTaskDependency(taskBId, taskAId);
      const tasks = ctx.manager.listTasks();
      const taskB = tasks.find((t) => t.id === taskBId);
      expect(taskB?.blockedBy).toContain(taskAId);
    });

    it("When TaskCreate is called for task-C depending on task-A depending on task-C", () => {
      taskCId = ctx.manager.createTask("Task C", "Would create cycle").id;
      ctx.manager.addTaskDependency(taskCId, taskAId);
      ctx.manager.addTaskDependency(taskAId, taskCId);
    });

    it("Then circular dependency is detected", () => {
      const cycles = ctx.manager.detectCircularDependencies();
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  // Scenario 16: Task completion removes from blockedBy of dependents
  describe("Scenario: Task completion removes from blockedBy of dependents", () => {
    let ctx: BddContext;
    let taskDId: string;
    let taskEId: string;
    let taskFId: string;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given task-D depends on task-E and task-F", () => {
      taskEId = ctx.manager.createTask("Task E", "First dependency").id;
      taskFId = ctx.manager.createTask("Task F", "Second dependency").id;
      taskDId = ctx.manager.createTask("Task D", "Depends on E and F").id;

      ctx.manager.addTaskDependency(taskDId, taskEId);
      ctx.manager.addTaskDependency(taskDId, taskFId);
    });

    it('And task-D blockedBy is ["task-E", "task-F"]', () => {
      const tasks = ctx.manager.listTasks();
      const taskD = tasks.find((t) => t.id === taskDId);
      expect(taskD?.blockedBy).toContain(taskEId);
      expect(taskD?.blockedBy).toContain(taskFId);
      expect(taskD?.blockedBy?.length).toBe(2);
    });

    it("When task-E is completed", () => {
      ctx.manager.claimTask(taskEId, "session-1");
      ctx.manager.completeTask(taskEId);
    });

    it('Then task-D blockedBy is ["task-F"]', () => {
      const tasks = ctx.manager.listTasks();
      const taskD = tasks.find((t) => t.id === taskDId);
      expect(taskD?.blockedBy).not.toContain(taskEId);
      expect(taskD?.blockedBy).toContain(taskFId);
      expect(taskD?.blockedBy?.length).toBe(1);
    });

    it("When task-F is completed", () => {
      ctx.manager.claimTask(taskFId, "session-1");
      ctx.manager.completeTask(taskFId);
    });

    it("Then task-D blockedBy is []", () => {
      const tasks = ctx.manager.listTasks();
      const taskD = tasks.find((t) => t.id === taskDId);
      expect(taskD?.blockedBy?.length).toBe(0);
    });
  });

  // Scenario 17: Query tasks by metadata filters
  describe("Scenario: Query tasks by metadata filters", () => {
    let ctx: BddContext;

    beforeEach(() => {
      ctx = createTestContext();
    });

    afterEach(() => {
      cleanupContext(ctx);
    });

    it("Given tasks have various metadata values", () => {
      ctx.manager.createTask("High priority task", "Important", {
        metadata: { priority: "high", category: "urgent" },
      });
      ctx.manager.createTask("Low priority task", "Not urgent", {
        metadata: { priority: "low", category: "routine" },
      });
      ctx.manager.createTask("Medium priority task", "Normal", {
        metadata: { priority: "medium", category: "standard" },
      });
      ctx.manager.createTask("Another high priority", "Critical", {
        metadata: { priority: "high", category: "critical" },
      });
    });

    it("When TaskList is queried for specific metadata", () => {
      const tasks = ctx.manager.listTasks();
      ctx.results.allTasks = tasks;
      ctx.results.highPriorityTasks = tasks.filter((t) => t.metadata?.priority === "high");
      ctx.results.urgentTasks = tasks.filter((t) => t.metadata?.category === "urgent");
    });

    it("Then only matching tasks are returned", () => {
      const highPriorityTasks = ctx.results.highPriorityTasks as TaskWithComputed[];
      const urgentTasks = ctx.results.urgentTasks as TaskWithComputed[];

      expect(highPriorityTasks.length).toBe(2);
      expect(highPriorityTasks.every((t) => t.metadata?.priority === "high")).toBe(true);

      expect(urgentTasks.length).toBe(1);
      expect(urgentTasks.every((t) => t.metadata?.category === "urgent")).toBe(true);
    });
  });
});
