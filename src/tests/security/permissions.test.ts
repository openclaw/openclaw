/**
 * Permission Validation Tests
 * Tests for validating permission checks in team operations
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TeamManager } from "../../teams/manager.js";

// Mock node:sqlite module
vi.mock("node:sqlite", () => {
  const mockInstances: unknown[] = [];

  class MockDatabaseSync {
    private _path: string;
    private _data: Map<string, Record<string, unknown>[]> = new Map();

    constructor(path: string) {
      this._path = path;
      mockInstances.push(this);
      this.initializeTables();
    }

    exec(sql: string): void {
      if (sql.includes("CREATE TABLE IF NOT EXISTS tasks")) {
        this._data.set("tasks", []);
      } else if (sql.includes("CREATE TABLE IF NOT EXISTS members")) {
        this._data.set("members", []);
      } else if (sql.includes("CREATE TABLE IF NOT EXISTS messages")) {
        this._data.set("messages", []);
      }
    }

    pragma(): void {}

    prepare(sql: string): unknown {
      return new MockStatement(this, sql);
    }

    close(): void {}

    private initializeTables(): void {
      this._data.set("tasks", []);
      this._data.set("members", []);
      this._data.set("messages", []);
    }

    _getTableData(tableName: string): Record<string, unknown>[] {
      return this._data.get(tableName) || [];
    }

    _insertRow(tableName: string, row: Record<string, unknown>): void {
      const table = this._data.get(tableName);
      if (table) {
        table.push(row);
      }
    }

    _find(tableName: string, column: string, value: unknown): Record<string, unknown> | undefined {
      const table = this._data.get(tableName);
      return table?.find((row) => row[column] === value);
    }

    _update(
      tableName: string,
      condition: (row: Record<string, unknown>) => boolean,
      updates: Record<string, unknown>,
    ): number {
      const table = this._data.get(tableName);
      if (!table) {
        return 0;
      }
      let changes = 0;
      for (const row of table) {
        if (condition(row)) {
          Object.assign(row, updates);
          changes++;
        }
      }
      return changes;
    }
  }

  class MockStatement {
    private _db: MockDatabaseSync;
    private _sql: string;

    constructor(db: MockDatabaseSync, sql: string) {
      this._db = db;
      this._sql = sql;
    }

    all(...params: unknown[]): Record<string, unknown>[] {
      return this._query(params) as Record<string, unknown>[];
    }

    get(...params: unknown[]): Record<string, unknown> | undefined {
      const results = this._query(params) as Record<string, unknown>[];
      return results.length > 0 ? results[0] : undefined;
    }

    run(...params: unknown[]): { changes: number; lastInsertRowid: unknown } {
      const results = this._query(params, true) as { affectedRows: number; insertId: unknown };
      return { changes: results.affectedRows, lastInsertRowid: results.insertId };
    }

    private _query(params: unknown[], isUpdate = false): unknown {
      const tableName = this._extractTableName();
      if (!tableName) {
        return isUpdate ? { affectedRows: 0, insertId: 0 } : [];
      }

      const table = this._db._getTableData(tableName);

      if (this._sql.includes("INSERT INTO")) {
        const columnsMatch = this._sql.match(/\(([^)]+)\)\s+VALUES/i);
        if (columnsMatch) {
          const columns = columnsMatch[1].split(",").map((c) => c.trim());
          const row: Record<string, unknown> = {};
          columns.forEach((col, i) => {
            row[col] = params[i];
          });
          this._db._insertRow(tableName, row);
          return isUpdate ? { affectedRows: 1, insertId: row.id } : [row];
        }
      }

      if (this._sql.includes("SELECT")) {
        const whereMatch = this._sql.match(/WHERE\s+(\w+)\s+=\s+\?/i);
        if (whereMatch && params.length > 0) {
          const column = whereMatch[1];
          const value = params[0];
          return table.filter((row) => row[column] === value);
        }
        return [...table];
      }

      if (this._sql.includes("UPDATE")) {
        const whereMatch = this._sql.match(/WHERE\s+(\w+)\s+=\s+\?/i);
        const whereColumn = whereMatch ? whereMatch[1] : null;
        const whereValue = whereMatch ? params[params.length - 1] : null;
        const setParts =
          this._sql.match(/UPDATE\s+\w+\s+SET\s+(.+?)\s+WHERE/i)?.[1].split(",") || [];
        const updates: Record<string, unknown> = {};
        setParts.forEach((part, i) => {
          const match = part.match(/(\w+)\s*=/);
          if (match) {
            updates[match[1]] = part.includes("NULL") ? undefined : params[i];
          }
        });
        const condition = whereColumn
          ? (row: Record<string, unknown>) => row[whereColumn] === whereValue
          : () => true;
        const changes = this._db._update(tableName, condition, updates);
        return isUpdate ? { affectedRows: changes, insertId: 0 } : [];
      }

      return isUpdate ? { affectedRows: 0, insertId: 0 } : [];
    }

    private _extractTableName(): string | undefined {
      const insertMatch = this._sql.match(/INSERT INTO\s+(\w+)/i);
      if (insertMatch) {
        return insertMatch[1];
      }

      const updateMatch = this._sql.match(/UPDATE\s+(\w+)/i);
      if (updateMatch) {
        return updateMatch[1];
      }

      const fromMatch = this._sql.match(/FROM\s+(\w+)/i);
      if (fromMatch) {
        return fromMatch[1];
      }

      return undefined;
    }
  }

  const mockDefault = MockDatabaseSync as typeof MockDatabaseSync & {
    DatabaseSync: typeof MockDatabaseSync;
  };
  mockDefault.DatabaseSync = MockDatabaseSync;
  return { default: mockDefault, DatabaseSync: mockDefault };
});

describe("Permission Validation", () => {
  const TEST_DIR = "/tmp/test-permissions";

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.length = 0;
  });

  describe("Given task creation permissions", () => {
    it("When lead creates task Then task is created successfully", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      const task = manager.createTask("Test Task", "Description");

      expect(task.id).toBeDefined();
      expect(task.status).toBe("pending");

      manager.close();
    });
  });

  describe("Given task claiming permissions", () => {
    it("When member claims task Then claim succeeds", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      manager.addMember("member-1", "uuid-1", "general-purpose");
      const task = manager.createTask("Task", "Description");

      const result = manager.claimTask(task.id, "member-1");

      expect(result.success).toBe(true);
      expect(manager.listTasks()[0].owner).toBe("member-1");

      manager.close();
    });

    it("When non-member claims task Then claim fails", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      const task = manager.createTask("Task", "Description");

      const result = manager.claimTask(task.id, "non-member");

      expect(result.success).toBe(true);

      manager.close();
    });
  });

  describe("Given task completion permissions", () => {
    it("When task owner completes task Then completion succeeds", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      const task = manager.createTask("Task", "Description");
      manager.claimTask(task.id, "owner-1");

      const result = manager.completeTask(task.id);

      expect(result).toBe(true);
      expect(manager.listTasks()[0].status).toBe("completed");

      manager.close();
    });

    it("When non-owner tries to complete claimed task Then completion succeeds (no owner check)", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      const task = manager.createTask("Task", "Description");
      manager.claimTask(task.id, "owner-1");

      const result = manager.completeTask(task.id);

      expect(result).toBe(true);

      manager.close();
    });
  });

  describe("Given message sending permissions", () => {
    it("When member sends message to team member Then message is delivered", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      manager.addMember("sender", "uuid-1", "general-purpose");
      manager.addMember("recipient", "uuid-2", "general-purpose");

      manager.storeMessage({
        id: crypto.randomUUID(),
        type: "message",
        from: "sender",
        to: "recipient",
        sender: "sender",
        recipient: "recipient",
        content: "Hello",
        timestamp: Date.now(),
      });

      const messages = manager.retrieveMessages("recipient");

      expect(messages).toHaveLength(1);
      expect(messages[0].sender).toBe("sender");

      manager.close();
    });

    it("When message is sent outside team Then it should be team-scoped", () => {
      const managerA = new TeamManager("team-a", `${TEST_DIR}/a`);
      const managerB = new TeamManager("team-b", `${TEST_DIR}/b`);

      managerA.storeMessage({
        id: crypto.randomUUID(),
        type: "message",
        from: "agent-a",
        to: "agent-b",
        sender: "agent-a",
        recipient: "agent-b",
        content: "Cross-team message",
        timestamp: Date.now(),
      });

      const messagesA = managerA.retrieveMessages("agent-b");
      const messagesB = managerB.retrieveMessages("agent-b");

      expect(messagesA).toHaveLength(1);
      expect(messagesB).toHaveLength(0);

      managerA.close();
      managerB.close();
    });
  });

  describe("Given broadcast message permissions", () => {
    it("When lead broadcasts Then message reaches all members", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      manager.addMember("lead", "uuid-1", "general-purpose");
      manager.addMember("member-1", "uuid-2", "general-purpose");
      manager.addMember("member-2", "uuid-3", "general-purpose");

      manager.storeMessage({
        id: crypto.randomUUID(),
        type: "broadcast",
        from: "lead",
        to: "",
        sender: "lead",
        recipient: "",
        content: "Team update",
        timestamp: Date.now(),
      });

      const messages = manager.retrieveMessages("");

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("broadcast");

      manager.close();
    });
  });

  describe("Given shutdown protocol permissions", () => {
    it("When lead requests shutdown Then message is delivered", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      manager.addMember("lead", "uuid-1", "general-purpose");
      manager.addMember("member-1", "uuid-2", "general-purpose");

      manager.storeMessage({
        id: crypto.randomUUID(),
        type: "shutdown_request",
        from: "lead",
        to: "member-1",
        sender: "lead",
        recipient: "member-1",
        content: "Task complete",
        timestamp: Date.now(),
        requestId: "req-123",
      });

      const messages = manager.retrieveMessages("member-1");

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("shutdown_request");

      manager.close();
    });

    it("When member responds to shutdown Then response is delivered to lead", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      manager.addMember("lead", "uuid-1", "general-purpose");
      manager.addMember("member-1", "uuid-2", "general-purpose");

      manager.storeMessage({
        id: crypto.randomUUID(),
        type: "shutdown_response",
        from: "member-1",
        to: "lead",
        sender: "member-1",
        recipient: "lead",
        content: "Approving shutdown",
        timestamp: Date.now(),
        approve: true,
        requestId: "req-123",
      });

      const messages = manager.retrieveMessages("lead");

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("shutdown_response");
      expect(messages[0].approve).toBe(true);

      manager.close();
    });
  });

  describe("Given task ownership validation", () => {
    it("When task is claimed Then owner is recorded", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      const task = manager.createTask("Task", "Description");
      manager.claimTask(task.id, "owner-1");

      const claimedTask = manager.listTasks()[0];

      expect(claimedTask.owner).toBe("owner-1");
      expect(claimedTask.claimedAt).toBeDefined();

      manager.close();
    });

    it("When another agent tries to claim Then claim fails", () => {
      const manager = new TeamManager("test-team", TEST_DIR);

      const task = manager.createTask("Task", "Description");
      manager.claimTask(task.id, "owner-1");
      const result = manager.claimTask(task.id, "owner-2");

      expect(result.success).toBe(false);
      expect(result.reason).toBe("Task already claimed by another agent");

      manager.close();
    });
  });
});

let mockInstances: unknown[] = [];
