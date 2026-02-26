/**
 * Team Isolation Tests
 * Tests for ensuring team operations don't cross team boundaries
 */

import * as fs from "fs/promises";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ensureInboxDirectory } from "../../teams/inbox.js";
import { TeamManager } from "../../teams/manager.js";

// Mock path module
vi.mock("path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

// Mock fs module
vi.mock("fs/promises", () => ({
  mkdir: vi.fn(),
  appendFile: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

// Mock node:sqlite module
vi.mock("node:sqlite", () => {
  const mockInstances: unknown[] = [];

  class MockDatabaseSync {
    private _path: string;
    public _data: Map<string, Record<string, unknown>[]> = new Map();

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

    _query(
      tableName: string,
      condition?: (row: Record<string, unknown>) => boolean,
    ): Record<string, unknown>[] {
      const table = this._data.get(tableName) || [];
      return condition ? table.filter(condition) : table;
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

      if (this._sql.includes("DELETE FROM")) {
        const whereMatch = this._sql.match(/WHERE\s+(\w+)\s+=\s+\?/i);
        const condition = whereMatch
          ? (row: Record<string, unknown>) => row[whereMatch[1]] === params[0]
          : () => true;
        const initialLength = table.length;
        const filtered = table.filter((row) => !condition(row));
        this._db._data.set(tableName, filtered);
        return isUpdate ? { affectedRows: initialLength - filtered.length, insertId: 0 } : [];
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

      const deleteMatch = this._sql.match(/DELETE FROM\s+(\w+)/i);
      if (deleteMatch) {
        return deleteMatch[1];
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

describe("Team Isolation", () => {
  const TEST_DIR = "/tmp/test-isolation";

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.length = 0;
  });

  describe("Given separate teams A and B", () => {
    it("When A creates tasks Then B cannot access them", () => {
      const teamA = new TeamManager("team-a", `${TEST_DIR}/a`);
      const teamB = new TeamManager("team-b", `${TEST_DIR}/b`);

      teamA.createTask("A Task", "Description for A");

      const tasksA = teamA.listTasks();
      const tasksB = teamB.listTasks();

      expect(tasksA).toHaveLength(1);
      expect(tasksB).toHaveLength(0);

      teamA.close();
      teamB.close();
    });
  });

  describe("Given separate teams with members", () => {
    it("When A adds members Then B cannot see them", () => {
      const teamA = new TeamManager("team-a", `${TEST_DIR}/a`);
      const teamB = new TeamManager("team-b", `${TEST_DIR}/b`);

      teamA.addMember("agent-a", "uuid-a", "general-purpose");

      const membersA = teamA.listMembers();
      const membersB = teamB.listMembers();

      expect(membersA).toHaveLength(1);
      expect(membersB).toHaveLength(0);

      teamA.close();
      teamB.close();
    });
  });

  describe("Given separate teams with messages", () => {
    it("When A sends messages Then B cannot access them", () => {
      const teamA = new TeamManager("team-a", `${TEST_DIR}/a`);
      const teamB = new TeamManager("team-b", `${TEST_DIR}/b`);

      teamA.storeMessage({
        id: crypto.randomUUID(),
        type: "message",
        from: "agent-a",
        to: "agent-b",
        sender: "agent-a",
        recipient: "agent-b",
        content: "Secret message",
        timestamp: Date.now(),
      });

      const messagesA = teamA.retrieveMessages("agent-b");
      const messagesB = teamB.retrieveMessages("agent-b");

      expect(messagesA).toHaveLength(1);
      expect(messagesB).toHaveLength(0);

      teamA.close();
      teamB.close();
    });
  });

  describe("Given operations scoped to specific team", () => {
    it("When claiming task in team A Then B is unaffected", () => {
      const teamA = new TeamManager("team-a", `${TEST_DIR}/a`);
      const teamB = new TeamManager("team-b", `${TEST_DIR}/b`);

      const taskA = teamA.createTask("A Task", "Description");
      teamB.createTask("B Task", "Description");

      teamA.claimTask(taskA.id, "agent-a");

      const updatedA = teamA.listTasks()[0];
      const updatedB = teamB.listTasks()[0];

      expect(updatedA.owner).toBe("agent-a");
      expect(updatedA.status).toBe("in_progress");
      expect(updatedB.owner).toBe("");
      expect(updatedB.status).toBe("pending");

      teamA.close();
      teamB.close();
    });
  });

  describe("Given inbox operations across teams", () => {
    it("When ensuring inbox for team A Then B inbox remains separate", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await ensureInboxDirectory("team-a", TEST_DIR, "session-a");
      await ensureInboxDirectory("team-b", TEST_DIR, "session-a");

      const calls = vi.mocked(fs.mkdir).mock.calls;
      expect(calls[0][0]).toContain("team-a");
      expect(calls[1][0]).toContain("team-b");
      expect(calls[0][0]).not.toContain("team-b");
      expect(calls[1][0]).not.toContain("team-a");
    });
  });
});

let mockInstances: unknown[] = [];
