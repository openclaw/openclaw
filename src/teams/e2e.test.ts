/**
 * E2E Workflow Tests
 * End-to-end tests for complete team workflows
 */

import { describe, it, expect, vi } from "vitest";
import { TeamManager } from "./manager.js";

// Re-use the comprehensive mock from manager.test.ts
const mockInstances: unknown[] = [];

vi.mock("node:sqlite", () => {
  class MockDatabaseSync {
    private _path: string;
    private _pragmaCalls: string[] = [];
    private _execCalls: string[] = [];
    private _isOpen: boolean = true;
    private _preparedStatements: Map<string, unknown> = new Map();
    private _data: Map<string, unknown[]> = new Map();

    constructor(path: string) {
      this._path = path;
      mockInstances.push(this);
      this.initializeTables();
    }

    get path(): string {
      return this._path;
    }

    exec(sql: string): void {
      this._execCalls.push(sql);

      if (sql.includes("CREATE TABLE IF NOT EXISTS tasks")) {
        this._data.set("tasks", []);
      } else if (sql.includes("CREATE TABLE IF NOT EXISTS members")) {
        this._data.set("members", []);
      } else if (sql.includes("CREATE TABLE IF NOT EXISTS messages")) {
        this._data.set("messages", []);
      }
    }

    pragma(statement: string): void {
      this._pragmaCalls.push(statement);
    }

    prepare(sql: string): unknown {
      const key = sql;
      if (!this._preparedStatements.has(key)) {
        this._preparedStatements.set(key, new MockStatement(this, sql));
      }
      return this._preparedStatements.get(key);
    }

    close(): void {
      this._isOpen = false;
    }

    get execCalls(): readonly string[] {
      return this._execCalls;
    }

    get pragmaCalls(): readonly string[] {
      return this._pragmaCalls;
    }

    get isOpen(): boolean {
      return this._isOpen;
    }

    private initializeTables(): void {
      this._data.set("tasks", []);
      this._data.set("members", []);
      this._data.set("messages", []);
    }

    getData(table: string): unknown[] {
      return this._data.get(table) || [];
    }

    setData(table: string, data: unknown[]): void {
      this._data.set(table, data);
    }
  }

  class MockStatement {
    private _db: MockDatabaseSync;
    private _sql: string;

    constructor(db: MockDatabaseSync, sql: string) {
      this._db = db;
      this._sql = sql;
    }

    get(...args: unknown[]): unknown {
      const table = this._getTableFromSql();
      if (!table) {
        return null;
      }

      const data = this._db.getData(table) as Record<string, unknown>[];
      if (!data) {
        return null;
      }

      if (this._sql.includes("WHERE id = ?")) {
        return data.find((row) => row.id === args[0]);
      }
      if (this._sql.includes("WHERE sessionKey = ?")) {
        return data.find((row) => row.sessionKey === args[0]);
      }
      if (this._sql.includes("WHERE status = ?")) {
        return data.filter((row) => row.status === args[0]);
      }
      if (this._sql.includes("WHERE toSession = ?")) {
        return data.find((row) => row.toSession === args[0]);
      }
      return data[0];
    }

    all(...args: unknown[]): unknown[] {
      const table = this._getTableFromSql();
      if (!table) {
        return [];
      }

      const data = this._db.getData(table) || [];

      // Handle message filtering by recipient
      if (this._sql.includes("WHERE toSession = ?")) {
        return data.filter(
          (row: unknown) => (row as Record<string, unknown>).toSession === args[0],
        );
      }

      return data;
    }

    run(...args: unknown[]): { changes: number } {
      const table = this._getTableFromSql();
      if (!table) {
        return { changes: 0 };
      }

      const data = this._db.getData(table) as Record<string, unknown>[];

      if (this._sql.includes("INSERT INTO")) {
        const newRow: Record<string, unknown> = {};
        const columns =
          this._sql
            .match(/\(([^)]+)\)/)?.[1]
            .split(",")
            .map((c) => c.trim()) || [];
        columns.forEach((col, i) => {
          newRow[col] = args[i];
        });
        data.push(newRow);
        this._db.setData(table, data);
        return { changes: 1 };
      }

      if (this._sql.includes("UPDATE") && this._sql.includes("WHERE id = ?")) {
        const id = args[args.length - 1];
        const index = data.findIndex((row) => row.id === id);
        if (index >= 0) {
          const setPart = this._sql.match(/SET (.+) WHERE/)?.[1];
          if (setPart) {
            const assignments = setPart.split(",").map((s) => s.trim());
            assignments.forEach((assign, i) => {
              const [col] = assign.split("=").map((s) => s.trim());
              data[index][col] = args[i];
            });
          }
          this._db.setData(table, data);
          return { changes: 1 };
        }
      }

      if (this._sql.includes("DELETE FROM") && this._sql.includes("WHERE id = ?")) {
        const id = args[0];
        const index = data.findIndex((row) => row.id === id);
        if (index >= 0) {
          data.splice(index, 1);
          this._db.setData(table, data);
          return { changes: 1 };
        }
      }

      return { changes: 0 };
    }

    private _getTableFromSql(): string | null {
      if (this._sql.includes("tasks")) {
        return "tasks";
      }
      if (this._sql.includes("members")) {
        return "members";
      }
      if (this._sql.includes("messages")) {
        return "messages";
      }
      return null;
    }
  }

  return {
    default: MockDatabaseSync,
    DatabaseSync: MockDatabaseSync,
  };
});

describe("E2E Workflow Tests", () => {
  const TEST_DIR = "/tmp/test-e2e";

  describe("Complete Team Lifecycle", () => {
    it("should complete full team workflow", () => {
      // 1. Create team
      const manager = new TeamManager("my-team", TEST_DIR);

      // Verify team is created with config
      const state = manager.getTeamState();
      expect(state.config.team_name).toBe("my-team");

      // 2. Spawn teammates
      manager.addMember("researcher", "uuid-1", "general-purpose");
      manager.addMember("coder", "uuid-2", "general-purpose");
      manager.addMember("tester", "uuid-3", "general-purpose");

      let members = manager.listMembers();
      expect(members).toHaveLength(3);

      // 3. Create tasks
      const task1 = manager.createTask("Research feature", "Research new API", {
        activeForm: "Researching feature",
      }) as { id: string };
      const task2 = manager.createTask("Implement feature", "Implement the feature") as {
        id: string;
      };
      const task3 = manager.createTask("Write tests", "Write unit tests") as { id: string };

      let tasks = manager.listTasks();
      expect(tasks).toHaveLength(3);

      // 4. Claim and complete tasks
      const claim1 = manager.claimTask(task1.id, "researcher");
      expect(claim1.success).toBe(true);

      const claim2 = manager.claimTask(task2.id, "coder");
      expect(claim2.success).toBe(true);

      const claim3 = manager.claimTask(task3.id, "tester");
      expect(claim3.success).toBe(true);

      // Complete task 1
      manager.completeTask(task1.id);
      tasks = manager.listTasks();
      expect(tasks.find((t) => t.id === task1.id)?.status).toBe("completed");

      // Complete task 2
      manager.completeTask(task2.id);
      tasks = manager.listTasks();
      expect(tasks.find((t) => t.id === task2.id)?.status).toBe("completed");

      // Complete task 3
      manager.completeTask(task3.id);
      tasks = manager.listTasks();
      expect(tasks.find((t) => t.id === task3.id)?.status).toBe("completed");

      // 5. Exchange messages
      manager.storeMessage({
        id: "msg-1",
        type: "message",
        sender: "researcher",
        recipient: "coder",
        content: "Found great API docs",
        timestamp: Date.now(),
      });

      manager.storeMessage({
        id: "msg-2",
        type: "broadcast",
        sender: "coder",
        recipient: "",
        content: "Feature implementation complete",
        timestamp: Date.now(),
      });

      const inboxMessages = manager.retrieveMessages("coder");
      expect(inboxMessages.length).toBeGreaterThan(0);

      // 6. Team shutdown (simulated by closing)
      manager.close();

      // Verify manager is closed
      expect(() => manager.getTeamState()).toThrow();
    });

    it("should handle team with tasks and dependencies", () => {
      const manager = new TeamManager("dependency-team", TEST_DIR);

      // Add members
      manager.addMember("lead", "uuid-1", "general-purpose");
      manager.addMember("dev", "uuid-2", "general-purpose");

      // Create dependent tasks
      const task1 = manager.createTask("Setup", "Initial setup") as { id: string };
      const task2 = manager.createTask("Development", "Development work") as { id: string };
      const task3 = manager.createTask("Testing", "Testing work") as { id: string };

      // Add dependencies: task2 depends on task1, task3 depends on task2
      manager.addTaskDependency(task2.id, task1.id);
      manager.addTaskDependency(task3.id, task2.id);

      // Claim and complete in order
      manager.claimTask(task1.id, "lead");
      manager.completeTask(task1.id);

      manager.claimTask(task2.id, "dev");
      manager.completeTask(task2.id);

      manager.claimTask(task3.id, "dev");
      manager.completeTask(task3.id);

      // Verify all completed
      const tasks = manager.listTasks();
      const allCompleted = tasks.every((t) => t.status === "completed");
      expect(allCompleted).toBe(true);

      manager.close();
    });
  });

  describe("Parallel Task Work", () => {
    it("should distribute tasks across multiple teammates", () => {
      const manager = new TeamManager("parallel-team", TEST_DIR);

      // Create team with 3 members
      manager.addMember("agent-1", "uuid-1", "general-purpose");
      manager.addMember("agent-2", "uuid-2", "general-purpose");
      manager.addMember("agent-3", "uuid-3", "general-purpose");

      // Create 5 independent tasks
      const taskIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const task = manager.createTask(`Task ${i}`, `Description ${i}`) as { id: string };
        taskIds.push(task.id);
      }

      // Simulate teammates claiming available tasks
      const claims = [
        manager.claimTask(taskIds[0], "agent-1"),
        manager.claimTask(taskIds[1], "agent-2"),
        manager.claimTask(taskIds[2], "agent-3"),
        manager.claimTask(taskIds[3], "agent-1"),
        manager.claimTask(taskIds[4], "agent-2"),
      ];

      // All claims should succeed (tasks are independent)
      const successCount = claims.filter((c) => c.success).length;
      expect(successCount).toBe(5);

      // Verify no task is claimed twice
      const tasks = manager.listTasks();
      const claimedBy = tasks.map((t) => t.owner);
      const uniqueClaimedBy = new Set(claimedBy.filter(Boolean));
      expect(uniqueClaimedBy.size).toBe(3); // All 3 agents

      manager.close();
    });

    it("should prevent duplicate task claims", () => {
      const manager = new TeamManager("duplicate-team", TEST_DIR);

      manager.addMember("agent-1", "uuid-1", "general-purpose");
      manager.addMember("agent-2", "uuid-2", "general-purpose");

      const task = manager.createTask("Shared Task", "Only one can have it") as { id: string };

      // Both agents try to claim simultaneously
      const result1 = manager.claimTask(task.id, "agent-1");
      const result2 = manager.claimTask(task.id, "agent-2");

      // Only one should succeed
      const successCount = [result1, result2].filter((r) => r.success).length;
      expect(successCount).toBe(1);

      // Verify task is claimed by exactly one agent
      const tasks = manager.listTasks();
      const claimedTask = tasks.find((t) => t.id === task.id);
      expect(claimedTask?.owner).toBeDefined();

      manager.close();
    });

    it("should handle load with many tasks and members", () => {
      const manager = new TeamManager("load-test-team", TEST_DIR);

      // Create 10 members
      for (let i = 1; i <= 10; i++) {
        manager.addMember(`agent-${i}`, `uuid-${i}`, "general-purpose");
      }

      // Create 20 tasks
      const taskIds: string[] = [];
      for (let i = 1; i <= 20; i++) {
        const task = manager.createTask(`Task ${i}`, `Description ${i}`) as { id: string };
        taskIds.push(task.id);
      }

      // Each agent claims 2 tasks
      for (let i = 0; i < 20; i++) {
        const agentNum = (i % 10) + 1;
        manager.claimTask(taskIds[i], `agent-${agentNum}`);
      }

      // Complete all tasks
      for (const taskId of taskIds) {
        manager.completeTask(taskId);
      }

      // Verify all completed
      const tasks = manager.listTasks();
      const completedCount = tasks.filter((t) => t.status === "completed").length;
      expect(completedCount).toBe(20);

      manager.close();
    });
  });

  describe("Message Routing", () => {
    it("should store and retrieve messages", () => {
      const manager = new TeamManager("routing-team", TEST_DIR);

      manager.addMember("alice", "uuid-1", "general-purpose");
      manager.addMember("bob", "uuid-2", "general-purpose");

      // Alice sends to Bob
      manager.storeMessage({
        id: "msg-1",
        type: "message",
        sender: "alice",
        recipient: "bob",
        content: "Hey Bob!",
        timestamp: Date.now(),
      });

      // Bob should see the message
      const bobInbox = manager.retrieveMessages("bob");
      expect(bobInbox.length).toBeGreaterThanOrEqual(1);

      manager.close();
    });

    it("should handle broadcast type messages", () => {
      const manager = new TeamManager("broadcast-team", TEST_DIR);

      manager.addMember("lead", "uuid-1", "general-purpose");
      manager.addMember("member-1", "uuid-2", "general-purpose");

      // Team lead sends broadcast
      manager.storeMessage({
        id: "broadcast-1",
        type: "broadcast",
        sender: "lead",
        recipient: "",
        content: "Team meeting at 3pm",
        timestamp: Date.now(),
      });

      // Verify message was stored
      const messages = manager.retrieveMessages("");
      expect(messages.length).toBeGreaterThanOrEqual(1);

      manager.close();
    });
  });

  describe("Team State", () => {
    it("should preserve team state across operations", () => {
      const manager = new TeamManager("state-team", TEST_DIR);

      // Add initial state
      manager.addMember("member-1", "uuid-1", "general-purpose");
      manager.createTask("Initial Task", "Description");

      // Get state
      manager.getTeamState();

      // Add more state
      manager.addMember("member-2", "uuid-2", "general-purpose");
      manager.createTask("Second Task", "Description");

      // Get state again
      const state2 = manager.getTeamState();

      // Verify state preserved
      expect(state2.members.length).toBe(2);
      expect(state2.tasks.length).toBe(2);

      manager.close();
    });
  });
});
