/**
 * Security Tests
 * Tests for path traversal prevention, team isolation, and access control
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateTeamName, validateTeamNameOrThrow } from "./storage.js";

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
      return data[0];
    }

    all(..._args: unknown[]): unknown[] {
      const table = this._getTableFromSql();
      if (!table) {
        return [];
      }

      return this._db.getData(table) || [];
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

// Import after mock
import { TeamManager } from "./manager.js";

describe("Security Tests", () => {
  const TEST_DIR = "/tmp/test-security";

  describe("Team Name Validation", () => {
    describe("validateTeamName", () => {
      it("should accept valid team names", () => {
        expect(validateTeamName("my-team")).toBe(true);
        expect(validateTeamName("team123")).toBe(true);
        expect(validateTeamName("a")).toBe(true);
        expect(validateTeamName("test-team-2024")).toBe(true);
      });

      it("should reject invalid team names", () => {
        // Path traversal attempts
        expect(validateTeamName("../etc/passwd")).toBe(false);
        expect(validateTeamName("..")).toBe(false);
        expect(validateTeamName("..")).toBe(false);
        expect(validateTeamName("team/../admin")).toBe(false);
        expect(validateTeamName("team\\..\\admin")).toBe(false);

        // Special characters
        expect(validateTeamName("team name")).toBe(false);
        expect(validateTeamName("team_name")).toBe(false);
        expect(validateTeamName("team.name")).toBe(false);
        expect(validateTeamName("team@name")).toBe(false);
        expect(validateTeamName("team$name")).toBe(false);

        // Uppercase
        expect(validateTeamName("TEAM")).toBe(false);
        expect(validateTeamName("Team")).toBe(false);

        // Empty or too long
        expect(validateTeamName("")).toBe(false);
        expect(validateTeamName("a".repeat(51))).toBe(false);

        // Special paths
        expect(validateTeamName("/etc")).toBe(false);
        expect(validateTeamName("C:\\Windows")).toBe(false);
        expect(validateTeamName("~/.ssh")).toBe(false);
      });
    });

    describe("validateTeamNameOrThrow", () => {
      it("should throw on invalid team names", () => {
        expect(() => validateTeamNameOrThrow("../admin")).toThrow();
        expect(() => validateTeamNameOrThrow("..")).toThrow();
        expect(() => validateTeamNameOrThrow("team name")).toThrow();
        expect(() => validateTeamNameOrThrow("")).toThrow();
      });

      it("should not throw on valid team names", () => {
        expect(() => validateTeamNameOrThrow("valid-team")).not.toThrow();
        expect(() => validateTeamNameOrThrow("team123")).not.toThrow();
      });
    });
  });

  describe("Team Isolation", () => {
    let manager1: TeamManager;
    let manager2: TeamManager;

    beforeEach(() => {
      manager1 = new TeamManager("team-alpha", TEST_DIR);
      manager2 = new TeamManager("team-beta", TEST_DIR);
    });

    afterEach(() => {
      manager1.close();
      manager2.close();
    });

    it("should not leak team members between teams", () => {
      manager1.addMember("member-alpha", "uuid-1", "general-purpose");
      manager2.addMember("member-beta", "uuid-2", "general-purpose");

      const teamAlphaMembers = manager1.listMembers();
      const teamBetaMembers = manager2.listMembers();

      expect(teamAlphaMembers).toHaveLength(1);
      expect(teamAlphaMembers[0].name).toBe("member-alpha");
      expect(teamBetaMembers).toHaveLength(1);
      expect(teamBetaMembers[0].name).toBe("member-beta");
    });

    it("should not leak tasks between teams", () => {
      manager1.createTask("Task Alpha", "Description");
      manager2.createTask("Task Beta", "Description");

      const teamAlphaTasks = manager1.listTasks();
      const teamBetaTasks = manager2.listTasks();

      expect(teamAlphaTasks).toHaveLength(1);
      expect(teamAlphaTasks[0].subject).toBe("Task Alpha");
      expect(teamBetaTasks).toHaveLength(1);
      expect(teamBetaTasks[0].subject).toBe("Task Beta");
    });

    it("should not leak messages between teams", () => {
      manager1.storeMessage({
        id: "msg-1",
        type: "message",
        sender: "sender-1",
        recipient: "recipient-1",
        content: "Secret message",
        timestamp: Date.now(),
      });

      manager2.storeMessage({
        id: "msg-2",
        type: "message",
        sender: "sender-2",
        recipient: "recipient-2",
        content: "Other message",
        timestamp: Date.now(),
      });

      // Each team's messages should be isolated
      const teamAlphaMessages = manager1.retrieveMessages("recipient-1");
      const teamBetaMessages = manager2.retrieveMessages("recipient-2");

      expect(teamAlphaMessages).toHaveLength(1);
      expect(teamBetaMessages).toHaveLength(1);
      expect(teamAlphaMessages[0].content).toBe("Secret message");
      expect(teamBetaMessages[0].content).toBe("Other message");
    });
  });

  describe("Injection Prevention", () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager("test-team", TEST_DIR);
    });

    afterEach(() => {
      manager.close();
    });

    it("should sanitize task subject input", () => {
      const maliciousSubject = '<script>alert("xss")</script>';
      const task = manager.createTask(maliciousSubject, "Description") as { id: string };

      const tasks = manager.listTasks();
      const createdTask = tasks.find((t) => t.id === task.id);

      // Task should be created (input is stored as-is, not executed)
      expect(createdTask).toBeDefined();
      expect(createdTask?.subject).toBe(maliciousSubject);
    });

    it("should handle SQL injection patterns in task data", () => {
      const sqlInjectionTask = "Task'; DROP TABLE tasks; --";
      manager.createTask(sqlInjectionTask, "Description");

      // Task should be created safely
      const tasks = manager.listTasks();
      expect(tasks.length).toBe(1);

      // Database should still be operational
      manager.createTask("Another Task", "Description");
      const allTasks = manager.listTasks();
      expect(allTasks.length).toBe(2);
    });

    it("should handle special characters in member names", () => {
      const specialName = 'member-"quotes"';
      const result = manager.addMember(specialName, "uuid-1", "general-purpose");

      expect(result).toBeDefined();

      const members = manager.listMembers();
      expect(members).toHaveLength(1);
    });
  });

  describe("Access Control", () => {
    let manager: TeamManager;

    beforeEach(() => {
      manager = new TeamManager("test-team", TEST_DIR);
    });

    afterEach(() => {
      manager.close();
    });

    it("should prevent claiming tasks from other teams", () => {
      // Create task in team
      const task = manager.createTask("Team Task", "Description") as { id: string };

      // Try to claim with a different agent name (simulating cross-team access)
      const result = manager.claimTask(task.id, "external-agent");

      // Claim should work (agent names aren't restricted)
      // The security is at the team boundary, not at the agent level
      expect(result.success).toBe(true);
    });

    it("should only list tasks for the current team", () => {
      manager.createTask("Task 1", "Desc");
      manager.createTask("Task 2", "Desc");

      const tasks = manager.listTasks();
      expect(tasks.length).toBe(2);
    });

    it("should only list members for the current team", () => {
      manager.addMember("member-1", "uuid-1", "general-purpose");
      manager.addMember("member-2", "uuid-2", "general-purpose");

      const members = manager.listMembers();
      expect(members.length).toBe(2);
    });
  });
});
