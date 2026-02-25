/**
 * SQLite Ledger Initialization Tests
 * Tests for TeamLedger database initialization and schema management
 * Based on OpenClaw Agent Teams Design (2026-02-23)
 */

import { rm } from "fs/promises";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TeamLedger } from "./ledger.js";

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

    constructor(path: string) {
      this._path = path;
      mockInstances.push(this);
    }

    get path(): string {
      return this._path;
    }

    exec(sql: string): void {
      this._execCalls.push(sql);
    }

    pragma(statement: string): void {
      this._pragmaCalls.push(statement);
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
  }

  // The module uses both default export and DatabaseSync property
  const mockDefault = MockDatabaseSync;
  mockDefault.DatabaseSync = MockDatabaseSync;
  return {
    default: mockDefault,
    DatabaseSync: mockDefault,
  };
});

// Helper to get the most recent database instance
function getLatestMockInstance(): MockDatabaseSync {
  return mockInstances[mockInstances.length - 1];
}

// Helper to get all database instances
function getAllMockInstances(): readonly unknown[] {
  return [...mockInstances];
}

describe("SQLite Ledger Initialization", () => {
  const TEST_DIR = join(process.cwd(), "tmp", "ledger-test");

  beforeEach(async () => {
    // Clear all mock instances
    mockInstances.length = 0;

    // Clean up test directory
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  describe("Schema Creation", () => {
    it("should create tasks table with correct schema", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;
      const tasksTableSql = execCalls.find((sql: string) =>
        sql.includes("CREATE TABLE IF NOT EXISTS tasks"),
      );

      expect(tasksTableSql).toBeDefined();
      expect(tasksTableSql).toContain("id TEXT PRIMARY KEY");
      expect(tasksTableSql).toContain("subject TEXT NOT NULL");
      expect(tasksTableSql).toContain("description TEXT NOT NULL");
      expect(tasksTableSql).toContain("activeForm TEXT");
      expect(tasksTableSql).toContain(
        "status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'in_progress', 'completed', 'failed'))",
      );
      expect(tasksTableSql).toContain("owner TEXT");
      expect(tasksTableSql).toContain("dependsOn TEXT");
      expect(tasksTableSql).toContain("blockedBy TEXT");
      expect(tasksTableSql).toContain("metadata TEXT");
      expect(tasksTableSql).toContain("createdAt INTEGER NOT NULL");
      expect(tasksTableSql).toContain("claimedAt INTEGER");
      expect(tasksTableSql).toContain("completedAt INTEGER");

      ledger.close();
    });

    it("should create members table with correct schema", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;
      const membersTableSql = execCalls.find((sql: string) =>
        sql.includes("CREATE TABLE IF NOT EXISTS members"),
      );

      expect(membersTableSql).toBeDefined();
      expect(membersTableSql).toContain("sessionKey TEXT PRIMARY KEY");
      expect(membersTableSql).toContain("agentId TEXT NOT NULL");
      expect(membersTableSql).toContain("name TEXT");
      expect(membersTableSql).toContain("role TEXT CHECK(role IN ('lead', 'member'))");
      expect(membersTableSql).toContain("joinedAt INTEGER NOT NULL");
      expect(membersTableSql).toContain("lastActiveAt INTEGER");

      ledger.close();
    });

    it("should create messages table with correct schema", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;
      const messagesTableSql = execCalls.find((sql: string) =>
        sql.includes("CREATE TABLE IF NOT EXISTS messages"),
      );

      expect(messagesTableSql).toBeDefined();
      expect(messagesTableSql).toContain("id TEXT PRIMARY KEY");
      expect(messagesTableSql).toContain("fromSession TEXT NOT NULL");
      expect(messagesTableSql).toContain("toSession TEXT NOT NULL");
      expect(messagesTableSql).toContain(
        "type TEXT NOT NULL CHECK(type IN ('message', 'broadcast', 'shutdown_request', 'shutdown_response', 'idle'))",
      );
      expect(messagesTableSql).toContain("content TEXT NOT NULL");
      expect(messagesTableSql).toContain("summary TEXT");
      expect(messagesTableSql).toContain("requestId TEXT");
      expect(messagesTableSql).toContain("approve INTEGER");
      expect(messagesTableSql).toContain("reason TEXT");
      expect(messagesTableSql).toContain("createdAt INTEGER NOT NULL");
      expect(messagesTableSql).toContain("delivered INTEGER DEFAULT 0");

      ledger.close();
    });

    it("should create indexes on tasks table", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;

      expect(
        execCalls.some((sql: string) =>
          sql.includes("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)"),
        ),
      ).toBe(true);
      expect(
        execCalls.some((sql: string) =>
          sql.includes("CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)"),
        ),
      ).toBe(true);
      expect(
        execCalls.some((sql: string) =>
          sql.includes("CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(createdAt)"),
        ),
      ).toBe(true);

      ledger.close();
    });

    it("should use CREATE TABLE IF NOT EXISTS for idempotency", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;

      // Check that all table creation statements use IF NOT EXISTS
      const createTableCalls = execCalls.filter((sql: string) => sql.includes("CREATE TABLE"));
      createTableCalls.forEach((sql: string) => {
        expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
      });

      ledger.close();
    });

    it("should create all three tables on initialization", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;

      expect(
        execCalls.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS tasks")),
      ).toBe(true);
      expect(
        execCalls.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS members")),
      ).toBe(true);
      expect(
        execCalls.some((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS messages")),
      ).toBe(true);

      ledger.close();
    });
  });

  describe("WAL Mode Configuration", () => {
    it("should enable WAL mode on initialization", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;

      expect(execCalls.length).toBeGreaterThan(0);
      expect(execCalls).toContain("PRAGMA journal_mode = WAL");

      ledger.close();
    });

    it("should configure WAL mode before schema creation", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const allCalls = [...instance.execCalls];

      const walPragmaIndex = allCalls.indexOf("PRAGMA journal_mode = WAL");
      const firstTableCreateIndex = allCalls.findIndex((call: string) =>
        call.includes("CREATE TABLE"),
      );

      expect(walPragmaIndex).toBeGreaterThanOrEqual(0);
      expect(firstTableCreateIndex).toBeGreaterThanOrEqual(0);
      expect(walPragmaIndex).toBeLessThan(firstTableCreateIndex);

      ledger.close();
    });

    it("should configure wal_autocheckpoint", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const execCalls = instance.execCalls;

      expect(execCalls).toContain("PRAGMA journal_mode = WAL");
      expect(execCalls).toContain("PRAGMA wal_autocheckpoint = 1000");

      ledger.close();
    });
  });

  describe("Idempotent Schema", () => {
    it("should not error when opening an already-opened database", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      const initialExecCallCount = instance.execCalls.length;

      // Open again - should be idempotent
      ledger.openDatabase();

      // No additional schema creation should occur
      expect(instance.execCalls.length).toBe(initialExecCallCount);

      ledger.close();
    });

    it("should handle multiple initialization calls safely", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);

      ledger.openDatabase();
      ledger.openDatabase();
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      // Should only create schema once (3 tables + 3 indexes = 6 CREATE statements)
      const createCalls = instance.execCalls.filter((sql: string) => sql.includes("CREATE"));
      expect(createCalls.length).toBe(6); // 3 tables + 3 indexes

      ledger.close();
    });
  });

  describe("Connection Lifecycle", () => {
    it("should track database open state", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);

      expect(ledger.isOpen()).toBe(false);

      ledger.openDatabase();

      expect(ledger.isOpen()).toBe(true);

      ledger.close();

      expect(ledger.isOpen()).toBe(false);
    });

    it("should close database connection properly", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      const instance = getLatestMockInstance();
      expect(instance.isOpen).toBe(true);

      ledger.close();

      expect(instance.isOpen).toBe(false);
    });

    it("should handle multiple close calls gracefully", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);
      ledger.openDatabase();

      expect(() => {
        ledger.close();
        ledger.close();
        ledger.close();
      }).not.toThrow();
    });

    it("should reopen database after closing", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);

      ledger.openDatabase();
      const firstInstance = getLatestMockInstance();

      ledger.close();

      expect(ledger.isOpen()).toBe(false);

      ledger.openDatabase();

      expect(ledger.isOpen()).toBe(true);
      const secondInstance = getLatestMockInstance();

      // Should create a new instance on reopen
      expect(secondInstance).not.toBe(firstInstance);

      ledger.close();
    });

    it("should use correct database file path", () => {
      const teamName = "my-team";
      const ledger = new TeamLedger(teamName, TEST_DIR);

      ledger.openDatabase();

      const instance = getLatestMockInstance();
      expect(instance.path).toBe(join(TEST_DIR, teamName, "ledger.db"));

      ledger.close();
    });

    it("should construct path with team name in directory structure", () => {
      const ledger1 = new TeamLedger("team-alpha", TEST_DIR);
      ledger1.openDatabase();

      const ledger2 = new TeamLedger("team-beta", TEST_DIR);
      ledger2.openDatabase();

      const instances = getAllMockInstances();
      expect(instances[0].path).toContain("team-alpha");
      expect(instances[1].path).toContain("team-beta");

      ledger1.close();
      ledger2.close();
    });
  });

  describe("Error Handling", () => {
    it("should throw error when checking schema without opening database", () => {
      const ledger = new TeamLedger("test-team", TEST_DIR);

      // Directly call ensureSchema (private method access via type casting)
      expect(() => {
        (ledger as unknown as { ensureSchema: () => void }).ensureSchema();
      }).toThrow("Database not opened");
    });
  });
});
