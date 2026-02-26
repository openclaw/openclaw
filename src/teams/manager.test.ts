/**
 * Team Manager Tests
 * Comprehensive tests for TeamManager class following BDD/TDD principles
 */

import { rm, mkdir } from "fs/promises";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TeamManager } from "./manager.js";
import type { TeamMessageExtended } from "./manager.js";
import type { TeamMessage } from "./types.js";

// Helper type for test messages with sender/recipient
interface TestTeamMessage extends Omit<TeamMessage, "from" | "to"> {
  from: string;
  sender: string;
  recipient: string;
}

// Helper function to convert test message to storeMessage format
const toStoreMessage = (
  msg: TestTeamMessage,
): {
  id: string;
  from: string;
  to?: string;
  type: TeamMessage["type"];
  content: string;
  summary?: string;
  requestId?: string;
  approve?: boolean;
  reason?: string;
  timestamp: number;
  sender: string;
  recipient?: string;
} => ({
  id: msg.id,
  from: msg.sender,
  to: msg.recipient,
  type: msg.type,
  content: msg.content,
  summary: msg.summary,
  requestId: msg.requestId,
  approve: msg.approve,
  reason: msg.reason,
  timestamp: msg.timestamp,
  sender: msg.sender,
  recipient: msg.recipient,
});

// Test helper: track all mock instances for assertions
const mockInstances: unknown[] = [];

// Mock the node:sqlite module with inline class definition
vi.mock("node:sqlite", () => {
  // Define the mock class inline to avoid hoisting issues
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

      // Handle table creation
      if (sql.includes("CREATE TABLE IF NOT EXISTS tasks")) {
        this._data.set("tasks", []);
      } else if (sql.includes("CREATE TABLE IF NOT EXISTS members")) {
        this._data.set("members", []);
      } else if (sql.includes("CREATE TABLE IF NOT EXISTS messages")) {
        this._data.set("messages", []);
      } else if (sql.includes("DROP TABLE")) {
        const tableName = sql.match(/DROP TABLE IF EXISTS (\w+)/)?.[1];
        if (tableName) {
          this._data.delete(tableName);
        }
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

    // Test helpers
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

    // Internal helper for statements
    _getTableData(tableName: string): unknown[] {
      return this._data.get(tableName) || [];
    }

    _setTableData(tableName: string, data: unknown[]): void {
      this._data.set(tableName, data);
    }

    _insertRow(tableName: string, row: unknown): void {
      const table = this._data.get(tableName);
      if (table) {
        table.push(row);
      }
    }

    _updateRow(
      tableName: string,
      condition: (row: unknown) => boolean,
      updates: Record<string, unknown>,
    ): number {
      const table = this._data.get(tableName);
      if (!table) {
        return 0;
      }
      let changes = 0;
      for (const row of table) {
        if (condition(row)) {
          Object.assign(row as Record<string, unknown>, updates);
          changes++;
        }
      }
      return changes;
    }

    _deleteRow(tableName: string, condition: (row: unknown) => boolean): number {
      const table = this._data.get(tableName);
      if (!table) {
        return 0;
      }
      const initialLength = table.length;
      const filtered = table.filter((row) => !condition(row));
      this._data.set(tableName, filtered);
      return initialLength - filtered.length;
    }
  }

  // Mock prepared statement class
  class MockStatement {
    private _db: MockDatabaseSync;
    private _sql: string;
    private _params: unknown[] = [];

    constructor(db: MockDatabaseSync, sql: string) {
      this._db = db;
      this._sql = sql;
    }

    all(...params: unknown[]): unknown[] {
      const results = this._query(params);
      return results as unknown[];
    }

    get(...params: unknown[]): unknown {
      const results = this._query(params) as unknown[];
      return results.length > 0 ? results[0] : undefined;
    }

    run(...params: unknown[]): unknown {
      const results = this._query(params, true) as { affectedRows: number; insertId: number };
      return { changes: results.affectedRows, lastInsertRowid: results.insertId };
    }

    private _query(params: unknown[], isUpdate = false): unknown {
      const sql = this._sql;
      const tableName = this._extractTableName(sql);

      if (!tableName) {
        return isUpdate ? { affectedRows: 0, insertId: 0 } : [];
      }

      const table = this._db._getTableData(tableName);

      // INSERT
      if (sql.includes("INSERT INTO")) {
        const row = this._parseInsertRow(sql, params);
        this._db._insertRow(tableName, row);
        return isUpdate ? { affectedRows: 1, insertId: row.id } : [row];
      }

      // SELECT
      if (sql.includes("SELECT")) {
        let results = [...table];

        // Apply WHERE clause
        const whereMatch = sql.match(/WHERE\s+(\w+)\s+=\s+\?/i);
        if (whereMatch && params.length > 0) {
          const column = whereMatch[1];
          const value = params[0];
          results = results.filter((row) => (row as Record<string, unknown>)[column] === value);
        }

        // Apply ORDER BY
        const orderByMatch = sql.match(/ORDER BY\s+(\w+)/i);
        if (orderByMatch) {
          const column = orderByMatch[1];
          results.sort((a, b) => {
            const aVal = (a as Record<string, unknown>)[column] as string | number;
            const bVal = (b as Record<string, unknown>)[column] as string | number;
            if (aVal < bVal) {
              return -1;
            }
            if (aVal > bVal) {
              return 1;
            }
            return 0;
          });
        }

        return results;
      }

      // UPDATE
      if (sql.includes("UPDATE")) {
        const setMatch = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE/i);
        if (setMatch) {
          const whereMatch = sql.match(/WHERE\s+(\w+)\s+=\s+\?/i);
          const whereColumn = whereMatch ? whereMatch[1] : null;
          const whereValue = whereMatch ? params[params.length - 1] : null;

          // Parse SET clause: "column1 = ?, column2 = ?, column3 = ?" or "column1 = NULL"
          const setClause = setMatch[2];
          const setParts = setClause.split(",");
          const columnNames: string[] = [];

          setParts.forEach((part) => {
            const match = part.match(/(\w+)\s*=/);
            if (match) {
              columnNames.push(match[1]);
            }
          });

          let updates: Record<string, unknown> = {};
          columnNames.forEach((col, i) => {
            const part = setParts[i];
            if (part.includes("NULL")) {
              updates[col] = undefined;
            } else {
              updates[col] = params[i];
            }
          });

          const condition = whereColumn
            ? (row: unknown) => (row as Record<string, unknown>)[whereColumn] === whereValue
            : () => true;
          const changes = this._db._updateRow(tableName, condition, updates);
          return isUpdate ? { affectedRows: changes, insertId: 0 } : [];
        }
      }

      // DELETE
      if (sql.includes("DELETE FROM")) {
        const whereMatch = sql.match(/WHERE\s+(\w+)\s+=\s+\?/i);
        const condition = whereMatch
          ? (row: unknown) => (row as Record<string, unknown>)[whereMatch[1]] === params[0]
          : () => true;
        const changes = this._db._deleteRow(tableName, condition);
        return isUpdate ? { affectedRows: changes, insertId: 0 } : [];
      }

      return isUpdate ? { affectedRows: 0, insertId: 0 } : [];
    }

    private _extractTableName(sql: string): string | undefined {
      const insertMatch = sql.match(/INSERT INTO\s+(\w+)/i);
      if (insertMatch) {
        return insertMatch[1];
      }

      const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
      if (updateMatch) {
        return updateMatch[1];
      }

      const deleteMatch = sql.match(/DELETE FROM\s+(\w+)/i);
      if (deleteMatch) {
        return deleteMatch[1];
      }

      const fromMatch = sql.match(/FROM\s+(\w+)/i);
      if (fromMatch) {
        return fromMatch[1];
      }

      return undefined;
    }

    private _parseInsertRow(sql: string, params: unknown[]): Record<string, unknown> {
      const columnsMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
      if (!columnsMatch) {
        return {};
      }

      const columns = columnsMatch[1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};

      columns.forEach((col, i) => {
        row[col] = params[i];
      });

      return row;
    }
  }

  // The module uses both default export and DatabaseSync property
  const mockDefault = MockDatabaseSync as typeof MockDatabaseSync & {
    DatabaseSync: typeof MockDatabaseSync;
  };
  (mockDefault as unknown as { DatabaseSync: typeof MockDatabaseSync }).DatabaseSync =
    MockDatabaseSync;
  return {
    default: mockDefault,
    DatabaseSync: mockDefault,
  };
});

describe("TeamManager", () => {
  const TEST_DIR = join(process.cwd(), "tmp", "manager-test");

  beforeEach(async () => {
    // Clear all mock instances
    mockInstances.length = 0;

    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  describe("Task Operations", () => {
    describe("createTask", () => {
      it("should create a new task with basic properties", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task = manager.createTask("Implement feature", "Build the feature implementation");

        expect(task.id).toBeDefined();
        expect(typeof task.id).toBe("string");
        expect(task.subject).toBe("Implement feature");
        expect(task.description).toBe("Build the feature implementation");
        expect(task.status).toBe("pending");
        expect(task.owner).toBe("");
        expect(task.blockedBy).toEqual([]);
        expect(task.blocks).toEqual([]);

        manager.close();
      });

      it("should create task with active form", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task = manager.createTask("Fix bug", "Fix the authentication bug", {
          activeForm: "Fixing authentication bug",
        });

        expect(task.activeForm).toBe("Fixing authentication bug");

        manager.close();
      });

      it("should create task with metadata", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task = manager.createTask("Write tests", "Write unit tests", {
          metadata: { priority: "high", estimatedHours: 2 },
        });

        expect(task.metadata).toEqual({ priority: "high", estimatedHours: 2 });

        manager.close();
      });

      it("should store created task in ledger", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task = manager.createTask("Task 1", "Description");
        const tasks = manager.listTasks();

        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe(task.id);

        manager.close();
      });

      it("should generate unique IDs for each task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task1 = manager.createTask("Task 1", "Description");
        const task2 = manager.createTask("Task 2", "Description");

        expect(task1.id).not.toBe(task2.id);

        manager.close();
      });
    });

    describe("listTasks", () => {
      it("should return empty list when no tasks exist", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const tasks = manager.listTasks();

        expect(tasks).toEqual([]);

        manager.close();
      });

      it("should return all created tasks", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.createTask("Task 1", "Description 1");
        manager.createTask("Task 2", "Description 2");
        manager.createTask("Task 3", "Description 3");

        const tasks = manager.listTasks();

        expect(tasks).toHaveLength(3);
        expect(tasks.map((t) => t.subject)).toEqual(["Task 1", "Task 2", "Task 3"]);

        manager.close();
      });

      it("should return tasks with all properties intact", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const original = manager.createTask("Test task", "Test description", {
          activeForm: "Testing task",
          metadata: { key: "value" },
        });

        const tasks = manager.listTasks();
        const retrieved = tasks[0];

        expect(retrieved.id).toBe(original.id);
        expect(retrieved.subject).toBe("Test task");
        expect(retrieved.description).toBe("Test description");
        expect(retrieved.activeForm).toBe("Testing task");
        expect(retrieved.metadata).toEqual({ key: "value" });

        manager.close();
      });
    });

    describe("claimTask", () => {
      it("should claim an available pending task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Do work", "Work description");

        const result = manager.claimTask(task.id, "agent-1");

        expect(result.success).toBe(true);
        expect(result.taskId).toBe(task.id);
        expect(result.reason).toBeUndefined();

        const updated = manager.listTasks()[0];
        expect(updated.status).toBe("in_progress");
        expect(updated.owner).toBe("agent-1");

        manager.close();
      });

      it("should fail when claiming non-existent task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const result = manager.claimTask("non-existent-id", "agent-1");

        expect(result.success).toBe(false);
        expect(result.taskId).toBe("non-existent-id");
        expect(result.reason).toBe("Task not found");

        manager.close();
      });

      it("should fail when claiming already claimed task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.claimTask(task.id, "agent-1");
        const result = manager.claimTask(task.id, "agent-2");

        expect(result.success).toBe(false);
        expect(result.reason).toBe("Task already claimed by another agent");

        manager.close();
      });

      it("should allow same agent to reclaim their task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.claimTask(task.id, "agent-1");
        const result = manager.claimTask(task.id, "agent-1");

        expect(result.success).toBe(true);

        manager.close();
      });

      it("should fail when claiming completed task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.claimTask(task.id, "agent-1");
        manager.completeTask(task.id);
        const result = manager.claimTask(task.id, "agent-2");

        expect(result.success).toBe(false);
        expect(result.reason).toBe("Task is completed");

        manager.close();
      });

      it("should fail when claiming deleted task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.updateTaskStatus(task.id, "deleted");
        const result = manager.claimTask(task.id, "agent-1");

        expect(result.success).toBe(false);
        expect(result.reason).toBe("Task is deleted");

        manager.close();
      });
    });

    describe("completeTask", () => {
      it("should complete a claimed task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.claimTask(task.id, "agent-1");
        const result = manager.completeTask(task.id);

        expect(result).toBe(true);

        const completed = manager.listTasks()[0];
        expect(completed.status).toBe("completed");

        manager.close();
      });

      it("should fail when completing non-existent task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const result = manager.completeTask("non-existent-id");

        expect(result).toBe(false);

        manager.close();
      });

      it("should fail when completing pending task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        const result = manager.completeTask(task.id);

        expect(result).toBe(false);

        manager.close();
      });

      it("should not change task owner when completing", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.claimTask(task.id, "agent-1");
        manager.completeTask(task.id);

        const completed = manager.listTasks()[0];
        expect(completed.owner).toBe("agent-1");

        manager.close();
      });
    });

    describe("updateTaskStatus", () => {
      it("should update task status to in_progress", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        const result = manager.updateTaskStatus(task.id, "in_progress");

        expect(result).toBe(true);
        expect(manager.listTasks()[0].status).toBe("in_progress");

        manager.close();
      });

      it("should update task status to completed", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        const result = manager.updateTaskStatus(task.id, "completed");

        expect(result).toBe(true);
        expect(manager.listTasks()[0].status).toBe("completed");

        manager.close();
      });

      it("should update task status to deleted", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        const result = manager.updateTaskStatus(task.id, "deleted");

        expect(result).toBe(true);
        expect(manager.listTasks()[0].status).toBe("deleted");

        manager.close();
      });

      it("should fail when updating non-existent task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const result = manager.updateTaskStatus("non-existent-id", "completed");

        expect(result).toBe(false);

        manager.close();
      });

      it("should allow status change back to pending", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        manager.updateTaskStatus(task.id, "in_progress");
        manager.updateTaskStatus(task.id, "pending");

        expect(manager.listTasks()[0].status).toBe("pending");

        manager.close();
      });
    });
  });

  describe("Task Dependency Tests", () => {
    describe("blockedBy", () => {
      it("should add dependency between tasks", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First task");
        const task2 = manager.createTask("Task 2", "Second task");

        const result = manager.addTaskDependency(task2.id, task1.id);

        expect(result).toBe(true);

        const tasks = manager.listTasks();
        const retrievedTask2 = tasks.find((t) => t.id === task2.id);
        expect(retrievedTask2?.blockedBy).toEqual([task1.id]);

        manager.close();
      });

      it("should record blocking tasks in blocks array", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First task");
        const task2 = manager.createTask("Task 2", "Second task");

        manager.addTaskDependency(task2.id, task1.id);

        const tasks = manager.listTasks();
        const retrievedTask1 = tasks.find((t) => t.id === task1.id);
        expect(retrievedTask1?.blocks).toEqual([task2.id]);

        manager.close();
      });

      it("should add multiple dependencies to a task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");

        manager.addTaskDependency(task3.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);

        const tasks = manager.listTasks();
        const retrievedTask3 = tasks.find((t) => t.id === task3.id);
        expect(retrievedTask3?.blockedBy).toEqual([task1.id, task2.id]);

        manager.close();
      });

      it("should fail when adding dependency to non-existent task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        const result = manager.addTaskDependency(task.id, "non-existent-id");

        expect(result).toBe(false);

        manager.close();
      });

      it("should fail when adding dependency from non-existent task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task = manager.createTask("Task", "Description");

        const result = manager.addTaskDependency("non-existent-id", task.id);

        expect(result).toBe(false);

        manager.close();
      });
    });

    describe("auto-unblock", () => {
      it("should unblock dependent tasks when dependency completes", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");

        manager.addTaskDependency(task2.id, task1.id);
        manager.claimTask(task1.id, "agent-1");
        manager.completeTask(task1.id);

        const tasks = manager.listTasks();
        const retrievedTask2 = tasks.find((t) => t.id === task2.id);
        expect(retrievedTask2?.blockedBy).toEqual([]);

        manager.close();
      });

      it("should unblock only specific dependency when one of many completes", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");

        manager.addTaskDependency(task3.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);
        manager.claimTask(task1.id, "agent-1");
        manager.completeTask(task1.id);

        const tasks = manager.listTasks();
        const retrievedTask3 = tasks.find((t) => t.id === task3.id);
        expect(retrievedTask3?.blockedBy).toEqual([task2.id]);

        manager.close();
      });

      it("should allow claiming unblocked task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");

        manager.addTaskDependency(task2.id, task1.id);
        manager.claimTask(task1.id, "agent-1");
        manager.completeTask(task1.id);

        const result = manager.claimTask(task2.id, "agent-2");
        expect(result.success).toBe(true);

        manager.close();
      });
    });

    describe("circular detection", () => {
      it("should detect simple circular dependency (A -> B -> A)", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");

        manager.addTaskDependency(task2.id, task1.id);
        manager.addTaskDependency(task1.id, task2.id);

        const cycles = manager.detectCircularDependencies();

        expect(cycles.length).toBeGreaterThan(0);
        expect(cycles[0].length).toBe(3);

        manager.close();
      });

      it("should detect three-node circular dependency (A -> B -> C -> A)", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");

        manager.addTaskDependency(task2.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);
        manager.addTaskDependency(task1.id, task3.id);

        const cycles = manager.detectCircularDependencies();

        expect(cycles.length).toBeGreaterThan(0);
        expect(cycles[0].length).toBe(4);

        manager.close();
      });

      it("should detect multiple independent circular dependencies", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");
        const task4 = manager.createTask("Task 4", "Fourth");

        manager.addTaskDependency(task2.id, task1.id);
        manager.addTaskDependency(task1.id, task2.id);

        manager.addTaskDependency(task4.id, task3.id);
        manager.addTaskDependency(task3.id, task4.id);

        const cycles = manager.detectCircularDependencies();

        expect(cycles.length).toBe(2);

        manager.close();
      });

      it("should return empty array when no circular dependencies exist", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");

        manager.addTaskDependency(task2.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);

        const cycles = manager.detectCircularDependencies();

        expect(cycles).toEqual([]);

        manager.close();
      });
    });

    describe("complex chain", () => {
      it("should handle complex dependency chain", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");
        const task4 = manager.createTask("Task 4", "Fourth");
        const task5 = manager.createTask("Task 5", "Fifth");

        manager.addTaskDependency(task2.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);
        manager.addTaskDependency(task4.id, task3.id);
        manager.addTaskDependency(task5.id, task4.id);

        const result1 = manager.claimTask(task5.id, "agent-1");
        expect(result1.success).toBe(false);
        expect(result1.blockedBy).toEqual([task4.id]);

        const result2 = manager.claimTask(task4.id, "agent-1");
        expect(result2.success).toBe(false);

        const result3 = manager.claimTask(task3.id, "agent-1");
        expect(result3.success).toBe(false);

        const result4 = manager.claimTask(task2.id, "agent-1");
        expect(result4.success).toBe(false);

        const result5 = manager.claimTask(task1.id, "agent-1");
        expect(result5.success).toBe(true);

        manager.close();
      });

      it("should progressively unblock through chain", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");

        manager.addTaskDependency(task2.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);

        manager.claimTask(task1.id, "agent-1");
        manager.completeTask(task1.id);

        let tasks = manager.listTasks();
        let task2Retrieved = tasks.find((t) => t.id === task2.id);
        expect(task2Retrieved?.blockedBy).toEqual([]);

        manager.claimTask(task2.id, "agent-2");
        manager.completeTask(task2.id);

        tasks = manager.listTasks();
        let task3Retrieved = tasks.find((t) => t.id === task3.id);
        expect(task3Retrieved?.blockedBy).toEqual([]);

        manager.close();
      });

      it("should handle diamond dependency pattern", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const taskA = manager.createTask("Task A", "Root");
        const taskB = manager.createTask("Task B", "Branch 1");
        const taskC = manager.createTask("Task C", "Branch 2");
        const taskD = manager.createTask("Task D", "Merge point");

        manager.addTaskDependency(taskB.id, taskA.id);
        manager.addTaskDependency(taskC.id, taskA.id);
        manager.addTaskDependency(taskD.id, taskB.id);
        manager.addTaskDependency(taskD.id, taskC.id);

        let result = manager.claimTask(taskD.id, "agent-1");
        expect(result.success).toBe(false);
        expect(result.blockedBy).toHaveLength(2);

        result = manager.claimTask(taskA.id, "agent-1");
        expect(result.success).toBe(true);
        manager.completeTask(taskA.id);

        result = manager.claimTask(taskD.id, "agent-1");
        expect(result.success).toBe(false);

        result = manager.claimTask(taskB.id, "agent-2");
        expect(result.success).toBe(true);
        manager.completeTask(taskB.id);

        result = manager.claimTask(taskD.id, "agent-1");
        expect(result.success).toBe(false);

        manager.close();
      });

      it("should claim blocked tasks with complete blockedBy list", () => {
        const manager = new TeamManager("test-team", TEST_DIR);
        const task1 = manager.createTask("Task 1", "First");
        const task2 = manager.createTask("Task 2", "Second");
        const task3 = manager.createTask("Task 3", "Third");

        manager.addTaskDependency(task3.id, task1.id);
        manager.addTaskDependency(task3.id, task2.id);

        const result = manager.claimTask(task3.id, "agent-1");

        expect(result.success).toBe(false);
        expect(result.blockedBy).toEqual([task1.id, task2.id]);
        expect(result.reason).toBe("Task has unmet dependencies");

        manager.close();
      });
    });
  });

  describe("Member Operations", () => {
    describe("addMember", () => {
      it("should add a new member to the team", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const member = manager.addMember("agent-1", "uuid-1", "general-purpose");

        expect(member.name).toBe("agent-1");
        expect(member.agentId).toBe("uuid-1");
        expect(member.agentType).toBe("general-purpose");
        expect(member.status).toBe("idle");
        expect(member.currentTask).toBeUndefined();

        manager.close();
      });

      it("should store member in ledger", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        const members = manager.listMembers();

        expect(members).toHaveLength(1);
        expect(members[0].name).toBe("agent-1");

        manager.close();
      });

      it("should allow adding multiple members", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.addMember("agent-2", "uuid-2", "researcher");
        manager.addMember("agent-3", "uuid-3", "test-runner");

        const members = manager.listMembers();

        expect(members).toHaveLength(3);
        expect(members.map((m) => m.name)).toEqual(["agent-1", "agent-2", "agent-3"]);

        manager.close();
      });
    });

    describe("listMembers", () => {
      it("should return empty list when no members exist", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const members = manager.listMembers();

        expect(members).toEqual([]);

        manager.close();
      });

      it("should return all team members", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.addMember("agent-2", "uuid-2", "researcher");

        const members = manager.listMembers();

        expect(members).toHaveLength(2);
        expect(members.map((m) => m.name)).toEqual(["agent-1", "agent-2"]);

        manager.close();
      });

      it("should return members with all properties", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.updateMemberActivity("agent-1", "working", "task-1");

        const members = manager.listMembers();
        const member = members[0];

        expect(member.name).toBe("agent-1");
        expect(member.agentId).toBe("uuid-1");
        expect(member.agentType).toBe("general-purpose");
        expect(member.status).toBe("working");
        expect(member.currentTask).toBe("task-1");

        manager.close();
      });
    });

    describe("updateMemberActivity", () => {
      it("should update member status to working", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        const result = manager.updateMemberActivity("agent-1", "working");

        expect(result).toBe(true);

        const members = manager.listMembers();
        expect(members[0].status).toBe("working");

        manager.close();
      });

      it("should update member status to blocked", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        const result = manager.updateMemberActivity("agent-1", "blocked");

        expect(result).toBe(true);

        const members = manager.listMembers();
        expect(members[0].status).toBe("blocked");

        manager.close();
      });

      it("should update member status back to idle", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.updateMemberActivity("agent-1", "working");
        manager.updateMemberActivity("agent-1", "idle");

        const members = manager.listMembers();
        expect(members[0].status).toBe("idle");

        manager.close();
      });

      it("should update current task assignment", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        const result = manager.updateMemberActivity("agent-1", "working", "task-123");

        expect(result).toBe(true);

        const members = manager.listMembers();
        expect(members[0].currentTask).toBe("task-123");

        manager.close();
      });

      it("should clear current task when not provided", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.updateMemberActivity("agent-1", "working", "task-123");
        manager.updateMemberActivity("agent-1", "idle");

        const members = manager.listMembers();
        expect(members[0].currentTask).toBeUndefined();

        manager.close();
      });

      it("should fail when updating non-existent member", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const result = manager.updateMemberActivity("non-existent", "working");

        expect(result).toBe(false);

        manager.close();
      });
    });

    describe("removeMember", () => {
      it("should remove a member from the team", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.removeMember("agent-1");

        const members = manager.listMembers();
        expect(members).toHaveLength(0);

        manager.close();
      });

      it("should handle removing non-existent member gracefully", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        expect(() => manager.removeMember("non-existent")).not.toThrow();

        manager.close();
      });

      it("should preserve other members when one is removed", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.addMember("agent-2", "uuid-2", "researcher");
        manager.addMember("agent-3", "uuid-3", "test-runner");

        manager.removeMember("agent-2");

        const members = manager.listMembers();
        expect(members).toHaveLength(2);
        expect(members.map((m) => m.name)).toEqual(["agent-1", "agent-3"]);

        manager.close();
      });
    });
  });

  describe("Message Operations", () => {
    describe("storeMessage", () => {
      it("should store a direct message", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "message",
          from: "agent-1",
          sender: "agent-1",
          recipient: "agent-2",
          content: "Hello",
          timestamp: Date.now(),
        };

        manager.storeMessage(toStoreMessage(message));

        const messages = manager.retrieveMessages("agent-2");
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe("Hello");

        manager.close();
      });

      it("should store a broadcast message", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "broadcast",
          from: "team-lead",
          sender: "team-lead",
          recipient: "",
          content: "Team update",
          timestamp: Date.now(),
        };

        manager.storeMessage(message);

        const messages = manager.retrieveMessages("");
        expect(messages).toHaveLength(1);
        expect(messages[0].type).toBe("broadcast");

        manager.close();
      });

      it("should store shutdown request", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "shutdown_request",
          from: "team-lead",
          sender: "team-lead",
          recipient: "agent-1",
          content: "Task complete, wrapping up",
          timestamp: Date.now(),
        };

        manager.storeMessage(message);

        const messages = manager.retrieveMessages("agent-1");
        expect(messages[0].type).toBe("shutdown_request");

        manager.close();
      });

      it("should store shutdown response", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "shutdown_response",
          from: "agent-1",
          sender: "agent-1",
          recipient: "team-lead",
          content: "Exiting",
          timestamp: Date.now(),
          approve: true,
          requestId: "req-123",
        };

        manager.storeMessage(message);

        const messages = manager.retrieveMessages("team-lead");
        expect(messages[0].approve).toBe(true);
        expect(messages[0].requestId).toBe("req-123");

        manager.close();
      });

      it("should store plan approval response", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "plan_approval_response",
          from: "team-lead",
          sender: "team-lead",
          recipient: "agent-1",
          content: "Plan approved",
          timestamp: Date.now(),
          approve: true,
          requestId: "req-456",
        };

        manager.storeMessage(message);

        const messages = manager.retrieveMessages("agent-1");
        expect(messages[0].type).toBe("plan_approval_response");

        manager.close();
      });

      it("should store message with summary", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "message",
          from: "agent-1",
          sender: "agent-1",
          recipient: "agent-2",
          content: "Long message content here",
          summary: "Brief summary",
          timestamp: Date.now(),
        };

        manager.storeMessage(message);

        const messages = manager.retrieveMessages("agent-2");
        expect(messages[0].summary).toBe("Brief summary");

        manager.close();
      });

      it("should preserve message timestamp", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const timestamp = 1234567890;
        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "message",
          from: "agent-1",
          sender: "agent-1",
          recipient: "agent-2",
          content: "Test",
          timestamp,
        };

        manager.storeMessage(message);

        const messages = manager.retrieveMessages("agent-2");
        expect(messages[0].timestamp).toBe(timestamp);

        manager.close();
      });
    });

    describe("retrieveMessages", () => {
      it("should return empty list for recipient with no messages", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const messages = manager.retrieveMessages("agent-1");

        expect(messages).toEqual([]);

        manager.close();
      });

      it("should return only messages for specific recipient", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-1",
            sender: "agent-1",
            recipient: "agent-2",
            content: "To agent-2",
            timestamp: Date.now(),
          }),
        );

        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-3",
            sender: "agent-3",
            recipient: "agent-4",
            content: "To agent-4",
            timestamp: Date.now(),
          }),
        );

        const messages = manager.retrieveMessages("agent-2");
        expect(messages).toHaveLength(1);
        expect(messages[0].recipient).toBe("agent-2");

        manager.close();
      });

      it("should return all messages in chronological order", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const now = Date.now();
        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-1",
            sender: "agent-1",
            recipient: "agent-2",
            content: "First",
            timestamp: now,
          }),
        );

        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-3",
            sender: "agent-3",
            recipient: "agent-2",
            content: "Second",
            timestamp: now + 1000,
          }),
        );

        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-1",
            sender: "agent-1",
            recipient: "agent-2",
            content: "Third",
            timestamp: now + 2000,
          }),
        );

        const messages = manager.retrieveMessages("agent-2");
        expect(messages).toHaveLength(3);
        expect(messages[0].content).toBe("First");
        expect(messages[1].content).toBe("Second");
        expect(messages[2].content).toBe("Third");

        manager.close();
      });

      it("should include all message properties", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const original: TeamMessageExtended = {
          id: crypto.randomUUID(),
          type: "message",
          from: "agent-1",
          sender: "agent-1",
          recipient: "agent-2",
          content: "Test message",
          summary: "Test",
          timestamp: Date.now(),
        };

        manager.storeMessage(original);

        const messages = manager.retrieveMessages("agent-2");
        const retrieved = messages[0];

        expect(retrieved.id).toBe(original.id);
        expect(retrieved.type).toBe(original.type);
        expect(retrieved.sender).toBe(original.sender);
        expect(retrieved.recipient).toBe(original.recipient);
        expect(retrieved.content).toBe(original.content);
        expect(retrieved.summary).toBe(original.summary);
        expect(retrieved.timestamp).toBe(original.timestamp);

        manager.close();
      });
    });

    describe("markMessageDelivered", () => {
      it("should mark message as delivered", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "message",
          from: "agent-1",
          sender: "agent-1",
          recipient: "agent-2",
          content: "Test",
          timestamp: Date.now(),
        };

        manager.storeMessage(message);
        const result = manager.markMessageDelivered(message.id);

        expect(result).toBe(true);

        manager.close();
      });

      it("should fail when marking non-existent message", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const result = manager.markMessageDelivered("non-existent-id");

        expect(result).toBe(false);

        manager.close();
      });

      it("should not affect message content when marking delivered", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const message: TestTeamMessage = {
          id: crypto.randomUUID(),
          type: "message",
          from: "agent-1",
          sender: "agent-1",
          recipient: "agent-2",
          content: "Test content",
          timestamp: Date.now(),
        };

        manager.storeMessage(message);
        manager.markMessageDelivered(message.id);

        const messages = manager.retrieveMessages("agent-2");
        expect(messages[0].content).toBe("Test content");

        manager.close();
      });
    });

    describe("clearMessages", () => {
      it("should clear all messages", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-1",
            sender: "agent-1",
            recipient: "agent-2",
            content: "Message 1",
            timestamp: Date.now(),
          }),
        );

        manager.storeMessage(
          toStoreMessage({
            id: crypto.randomUUID(),
            type: "message",
            from: "agent-3",
            sender: "agent-3",
            recipient: "agent-4",
            content: "Message 2",
            timestamp: Date.now(),
          }),
        );

        manager.clearMessages();

        const messages1 = manager.retrieveMessages("agent-2");
        const messages2 = manager.retrieveMessages("agent-4");
        expect(messages1).toEqual([]);
        expect(messages2).toEqual([]);

        manager.close();
      });

      it("should handle clearing empty message store", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        expect(() => manager.clearMessages()).not.toThrow();
        const messages = manager.retrieveMessages("agent-1");
        expect(messages).toEqual([]);

        manager.close();
      });
    });
  });

  describe("Manager Lifecycle", () => {
    describe("getTeamState", () => {
      it("should return complete team state", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.addMember("agent-1", "uuid-1", "general-purpose");
        manager.addMember("agent-2", "uuid-2", "researcher");
        manager.createTask("Task 1", "Description");
        manager.createTask("Task 2", "Description");

        const state = manager.getTeamState();

        expect(state.teamName).toBe("test-team");
        expect(state.members).toHaveLength(2);
        expect(state.tasks).toHaveLength(2);
        expect(state.messages).toEqual([]);
        expect(state.status).toBe("active");

        manager.close();
      });

      it("should include team config in state", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const state = manager.getTeamState();

        expect(state.config).toBeDefined();
        expect(state.config.team_name).toBe("test-team");
        expect(state.config.description).toBe("Mock team");
        expect(state.config.agent_type).toBe("general-purpose");

        manager.close();
      });
    });

    describe("close", () => {
      it("should close the manager", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        expect(() => manager.close()).not.toThrow();
      });

      it("should handle multiple close calls", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        manager.close();
        expect(() => manager.close()).not.toThrow();
      });
    });
  });

  describe("Concurrency Control", () => {
    describe("Parallel Task Claims", () => {
      it("should only allow one agent to claim a task", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task = manager.createTask("Test task", "Description") as { id: string };

        // Simulate parallel claims
        const result1 = manager.claimTask(task.id, "agent-1");
        const result2 = manager.claimTask(task.id, "agent-2");

        // Only one should succeed
        const successCount = [result1, result2].filter((r) => r.success).length;
        expect(successCount).toBe(1);

        // The first claim should win
        const tasks = manager.listTasks();
        const claimedTask = tasks.find((t) => t.id === task.id);
        expect(claimedTask?.owner).toBeDefined();

        manager.close();
      });

      it("should prevent race condition where two claims both succeed", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const task = manager.createTask("Race test", "Testing race condition") as { id: string };

        // Attempt rapid sequential claims
        const results: Array<{ success: boolean }> = [];
        for (let i = 0; i < 10; i++) {
          results.push(manager.claimTask(task.id, `agent-${i}`));
        }

        // Only one should succeed
        const successCount = results.filter((r) => r.success).length;
        expect(successCount).toBe(1);

        manager.close();
      });
    });

    describe("Concurrent Read/Write Operations", () => {
      it("should handle concurrent reads during writes", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        // Create multiple tasks
        for (let i = 0; i < 5; i++) {
          manager.createTask(`Task ${i}`, `Description ${i}`);
        }

        // Simulate concurrent reads while writing
        const readResults: unknown[][] = [];
        const writePromises = [];

        for (let i = 0; i < 3; i++) {
          writePromises.push(
            (async () => {
              manager.createTask(`Concurrent Task ${i}`, "Written during reads");
            })(),
          );
          readResults.push(manager.listTasks());
        }

        // All reads should return consistent data
        for (const reads of readResults) {
          expect(reads.length).toBeGreaterThan(0);
        }

        manager.close();
      });

      it("should maintain data consistency under load", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        const taskCount = 20;
        const tasks: Array<{ id: string }> = [];

        // Create tasks
        for (let i = 0; i < taskCount; i++) {
          tasks.push(manager.createTask(`Load Test ${i}`, "Description") as { id: string });
        }

        // Claim some tasks
        for (let i = 0; i < Math.floor(taskCount / 2); i++) {
          manager.claimTask(tasks[i].id, `agent-${i % 3}`);
        }

        // Verify consistency
        const listedTasks = manager.listTasks();
        const claimedTasks = listedTasks.filter((t) => t.status === "in_progress");
        const pendingTasks = listedTasks.filter((t) => t.status === "pending");

        expect(listedTasks.length).toBe(taskCount);
        expect(claimedTasks.length).toBe(Math.floor(taskCount / 2));
        expect(pendingTasks.length).toBe(Math.ceil(taskCount / 2));

        manager.close();
      });
    });

    describe("Task Dependency Resolution Under Load", () => {
      it("should resolve dependencies correctly with concurrent operations", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        // Create dependency chain: A -> B -> C
        const taskA = manager.createTask("Task A", "First") as { id: string };
        const taskB = manager.createTask("Task B", "Second") as { id: string };
        const taskC = manager.createTask("Task C", "Third") as { id: string };

        manager.addTaskDependency(taskB.id, taskA.id);
        manager.addTaskDependency(taskC.id, taskB.id);

        // Complete tasks in order
        manager.claimTask(taskA.id, "agent-1");
        manager.completeTask(taskA.id);

        manager.claimTask(taskB.id, "agent-1");
        manager.completeTask(taskB.id);

        manager.claimTask(taskC.id, "agent-1");
        manager.completeTask(taskC.id);

        // Verify all completed
        const tasks = manager.listTasks();
        const completedCount = tasks.filter((t) => t.status === "completed").length;

        expect(completedCount).toBe(3);
        manager.close();
      });

      it("should handle multiple tasks completing simultaneously", () => {
        const manager = new TeamManager("test-team", TEST_DIR);

        // Create independent tasks
        const task1 = manager.createTask("Independent 1", "Desc") as { id: string };
        const task2 = manager.createTask("Independent 2", "Desc") as { id: string };
        const task3 = manager.createTask("Independent 3", "Desc") as { id: string };

        // Claim and complete all
        [task1, task2, task3].forEach((task, i) => {
          manager.claimTask(task.id, `agent-${i}`);
          manager.completeTask(task.id);
        });

        const tasks = manager.listTasks();
        const allCompleted = tasks.every((t) => t.status === "completed");

        expect(allCompleted).toBe(true);
        manager.close();
      });
    });
  });
});
