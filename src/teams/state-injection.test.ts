/**
 * Team State Injection Tests
 * Tests for injecting team state into agent context
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { closeAll } from "./pool.js";
import { formatTeamState } from "./state-injection.js";
import type { TeamState } from "./types.js";

// Mock the node:sqlite module
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

    private initializeTables(): void {
      this._data.set("tasks", []);
      this._data.set("members", []);
      this._data.set("messages", []);
    }

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

    _findRow(tableName: string, condition: (row: unknown) => boolean): unknown {
      const table = this._data.get(tableName);
      if (!table) {
        return undefined;
      }
      return table.find(condition);
    }

    _updateRow(
      tableName: string,
      condition: (row: unknown) => boolean,
      updates: Partial<unknown>,
    ): boolean {
      const table = this._data.get(tableName);
      if (!table) {
        return false;
      }
      const row = table.find(condition);
      if (!row) {
        return false;
      }
      Object.assign(row, updates);
      return true;
    }

    _deleteRow(tableName: string, condition: (row: unknown) => boolean): boolean {
      const table = this._data.get(tableName);
      if (!table) {
        return false;
      }
      const index = table.findIndex(condition);
      if (index === -1) {
        return false;
      }
      table.splice(index, 1);
      return true;
    }

    _clearTable(tableName: string): void {
      this._data.set(tableName, []);
    }
  }

  class MockStatement {
    private _db: MockDatabaseSync;
    private _sql: string;
    private _boundParams: unknown[] = [];

    constructor(db: MockDatabaseSync, sql: string) {
      this._db = db;
      this._sql = sql;
    }

    all(...params: unknown[]): unknown[] {
      this._boundParams = params;
      const tableName = this.extractTableName();
      if (!tableName) {
        return [];
      }

      const table = this._db._getTableData(tableName);
      if (this._sql.includes("WHERE")) {
        const conditions = this.extractConditions();
        return table.filter((row) => conditions.every((cond) => cond(row)));
      }
      return [...table];
    }

    get(...params: unknown[]): unknown {
      this._boundParams = params;
      const tableName = this.extractTableName();
      if (!tableName) {
        return undefined;
      }

      const table = this._db._getTableData(tableName);
      if (this._sql.includes("WHERE")) {
        const conditions = this.extractConditions();
        return table.find((row) => conditions.every((cond) => cond(row)));
      }
      return table[0];
    }

    run(...params: unknown[]): unknown {
      this._boundParams = params;
      const tableName = this.extractTableName();

      if (this._sql.includes("INSERT")) {
        const data = this.extractInsertData();
        this._db._insertRow(tableName!, data);
        return { changes: 1, lastInsertRowid: 1 };
      } else if (this._sql.includes("UPDATE")) {
        const updates = this.extractUpdates();
        const conditions = this.extractConditions();
        const combinedCondition = (row: unknown) => conditions.every((cond) => cond(row));
        const updated = this._db._updateRow(tableName!, combinedCondition, updates);
        return { changes: updated ? 1 : 0 };
      } else if (this._sql.includes("DELETE")) {
        const conditions = this.extractConditions();
        const combinedCondition = (row: unknown) => conditions.every((cond) => cond(row));
        const deleted = this._db._deleteRow(tableName!, combinedCondition);
        return { changes: deleted ? 1 : 0 };
      }
      return { changes: 0 };
    }

    private extractTableName(): string | undefined {
      if (this._sql.includes("FROM tasks")) {
        return "tasks";
      }
      if (this._sql.includes("FROM members")) {
        return "members";
      }
      if (this._sql.includes("FROM messages")) {
        return "messages";
      }
      if (this._sql.includes("INSERT INTO tasks")) {
        return "tasks";
      }
      if (this._sql.includes("INSERT INTO members")) {
        return "members";
      }
      if (this._sql.includes("INSERT INTO messages")) {
        return "messages";
      }
      if (this._sql.includes("UPDATE tasks")) {
        return "tasks";
      }
      if (this._sql.includes("UPDATE members")) {
        return "members";
      }
      if (this._sql.includes("UPDATE messages")) {
        return "messages";
      }
      if (this._sql.includes("DELETE FROM tasks")) {
        return "tasks";
      }
      if (this._sql.includes("DELETE FROM members")) {
        return "members";
      }
      if (this._sql.includes("DELETE FROM messages")) {
        return "messages";
      }
      return undefined;
    }

    private extractConditions(): ((row: unknown) => boolean)[] {
      const conditions: ((row: unknown) => boolean)[] = [];
      const whereMatch = this._sql.match(/WHERE\s+(.+?)(?:\s+GROUP|\s+ORDER|\s+LIMIT|$)/i);
      if (whereMatch) {
        const whereClause = whereMatch[1];
        const matches = whereClause.matchAll(/(\w+)\s*=\s*\?/g);
        for (const match of matches) {
          const column = match[1];
          const index = Array.from(whereClause.matchAll(/\?/g)).findIndex((m, i, arr) => {
            const before = whereClause.slice(0, m.index);
            const currentColumn = before.match(/(\w+)\s*=\s*\?$/)?.[1];
            return (
              currentColumn === column &&
              arr.slice(0, i).every((x) => !whereClause.slice(0, x.index).includes(column + " = ?"))
            );
          });
          const param = this._boundParams[index] ?? this._boundParams[0];
          conditions.push((row: unknown) => (row as Record<string, unknown>)[column] === param);
        }
      }
      return conditions;
    }

    private extractInsertData(): Record<string, unknown> {
      const data: Record<string, unknown> = {};
      const columns = this._sql
        .match(/\(([^)]+)\)/)?.[1]
        ?.split(",")
        .map((c) => c.trim());
      if (columns) {
        columns.forEach((col, i) => {
          data[col] = this._boundParams[i];
        });
      }
      return data;
    }

    private extractUpdates(): Partial<unknown> {
      const updates: Record<string, unknown> = {};
      const setMatch = this._sql.match(/SET\s+(.+?)\s+WHERE/i);
      if (setMatch) {
        const setClause = setMatch[1];
        const matches = setClause.matchAll(/(\w+)\s*=\s*\?/g);
        for (const match of matches) {
          const column = match[1];
          const index = Array.from(setClause.matchAll(/\?/g)).findIndex((m, i, arr) => {
            const before = setClause.slice(0, m.index);
            const currentColumn = before.match(/(\w+)\s*=\s*$/)?.[1];
            return (
              currentColumn === column &&
              arr.slice(0, i).every((x) => !setClause.slice(0, x.index).includes(column + " = ?"))
            );
          });
          const param = this._boundParams[index];
          updates[column] = param;
        }
      }
      return updates;
    }
  }

  return {
    default: { DatabaseSync: MockDatabaseSync },
    DatabaseSync: MockDatabaseSync,
  };
});

const mockTeamState: TeamState = {
  id: "team-123",
  name: "test-team",
  description: "Test team for unit testing",
  status: "active",
  members: [
    {
      sessionKey: "lead-1",
      agentId: "agent-1",
      name: "Team Lead",
      role: "lead",
      joinedAt: Date.now(),
    },
    {
      sessionKey: "member-1",
      agentId: "agent-2",
      name: "Researcher",
      role: "member",
      joinedAt: Date.now(),
    },
  ],
  pendingTaskCount: 5,
  inProgressTaskCount: 2,
  completedTaskCount: 10,
};

const mockStateDir = "/tmp/test-openclaw";

describe("Team State Injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeAll();
  });

  describe("injectTeamState", () => {
    it("should return formatted team state for team lead session", async () => {
      const leadSession: SessionEntry = {
        sessionId: "session-1",
        sessionKey: "lead-1",
        teamId: "test-team",
        teamRole: "lead",
        teamName: "test-team",
        updatedAt: Date.now(),
      };

      const { injectTeamState } = await import("./state-injection.js");
      const result = await injectTeamState(leadSession, mockStateDir);

      expect(result).toContain("=== TEAM STATE ===");
      expect(result).toContain("Team: test-team");
      expect(result).toContain("Status: active");
      expect(result).toContain("Members");
      expect(result).toContain("Task Counts:");
      expect(result).toContain("====================");
    });

    it("should return empty string for team member session", async () => {
      const memberSession: SessionEntry = {
        sessionId: "session-2",
        sessionKey: "member-1",
        teamId: "test-team",
        teamRole: "member",
        teamName: "test-team",
        updatedAt: Date.now(),
      };

      const { injectTeamState } = await import("./state-injection.js");
      const result = await injectTeamState(memberSession, mockStateDir);

      expect(result).toBe("");
    });

    it("should return empty string for session without teamId", async () => {
      const nonTeamSession: SessionEntry = {
        sessionId: "session-3",
        sessionKey: "session-key",
        updatedAt: Date.now(),
      };

      const { injectTeamState } = await import("./state-injection.js");
      const result = await injectTeamState(nonTeamSession, mockStateDir);

      expect(result).toBe("");
    });

    it("should return empty string for session without teamRole", async () => {
      const sessionWithoutRole: SessionEntry = {
        sessionId: "session-4",
        sessionKey: "session-key",
        teamId: "test-team",
        updatedAt: Date.now(),
      };

      const { injectTeamState } = await import("./state-injection.js");
      const result = await injectTeamState(sessionWithoutRole, mockStateDir);

      expect(result).toBe("");
    });
  });

  describe("formatTeamState", () => {
    it("should format team state with header, members, and task counts", () => {
      const result = formatTeamState(mockTeamState);

      expect(result).toContain("=== TEAM STATE ===");
      expect(result).toContain("Team: test-team (team-123)");
      expect(result).toContain("Status: active");
      expect(result).toContain("Description: Test team for unit testing");
      expect(result).toContain("Members (2):");
      expect(result).toContain("Team Lead (Lead)");
      expect(result).toContain("Researcher (Member)");
      expect(result).toContain("Task Counts:");
      expect(result).toContain("Pending: 5");
      expect(result).toContain("In Progress: 2");
      expect(result).toContain("Completed: 10");
      expect(result).toContain("====================");
    });

    it("should handle team without description", () => {
      const stateWithoutDescription: TeamState = {
        id: "team-123",
        name: "test-team",
        status: "active",
        members: [],
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      };

      const result = formatTeamState(stateWithoutDescription);

      expect(result).toContain("Description: N/A");
    });

    it("should handle team with no members", () => {
      const stateWithoutMembers: TeamState = {
        id: "team-123",
        name: "test-team",
        description: "Empty team",
        status: "active",
        members: [],
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      };

      const result = formatTeamState(stateWithoutMembers);

      expect(result).toContain("Members (0):");
    });

    it("should display member name if available", () => {
      const stateWithNames: TeamState = {
        id: "team-123",
        name: "test-team",
        status: "active",
        members: [
          {
            sessionKey: "lead-1",
            agentId: "agent-1",
            name: "Alice",
            role: "lead",
            joinedAt: Date.now(),
          },
        ],
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      };

      const result = formatTeamState(stateWithNames);

      expect(result).toContain("Alice (Lead)");
    });

    it("should display sessionKey if member name not available", () => {
      const stateWithoutNames: TeamState = {
        id: "team-123",
        name: "test-team",
        status: "active",
        members: [
          {
            sessionKey: "member-1",
            agentId: "agent-1",
            role: "member",
            joinedAt: Date.now(),
          },
        ],
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      };

      const result = formatTeamState(stateWithoutNames);

      expect(result).toContain("member-1 (Member)");
    });

    it("should format shutdown status correctly", () => {
      const shutdownState: TeamState = {
        id: "team-123",
        name: "test-team",
        status: "shutdown",
        members: [],
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      };

      const result = formatTeamState(shutdownState);

      expect(result).toContain("Status: shutdown");
    });
  });

  describe("Context Amnesia Prevention", () => {
    it("should include team metadata for context persistence", () => {
      const result = formatTeamState(mockTeamState);

      expect(result).toContain("Team: test-team (team-123)");
      expect(result).toContain("Status: active");
    });

    it("should include member roster for context persistence", () => {
      const result = formatTeamState(mockTeamState);

      expect(result).toContain("Members (2):");
      expect(result).toContain("Team Lead (Lead)");
      expect(result).toContain("Researcher (Member)");
    });

    it("should include task counts for context persistence", () => {
      const result = formatTeamState(mockTeamState);

      expect(result).toContain("Task Counts:");
      expect(result).toContain("Pending: 5");
      expect(result).toContain("In Progress: 2");
      expect(result).toContain("Completed: 10");
    });
  });
});
