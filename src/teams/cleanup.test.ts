/**
 * Cleanup & Maintenance Tests
 * BDD tests for cleanup and maintenance functions
 */

import * as fs from "fs/promises";
import type { Stats, Dirent } from "node:fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanupOldMessages,
  archiveCompletedTasks,
  cleanupInactiveTeams,
  closeAllManagers,
  closeTeamManager,
  checkpointWAL,
  getTeamStats,
} from "./cleanup.js";
import { getTeamManager, closeAll } from "./pool.js";

// Helper types for test data
interface MockTask {
  id: string;
  status: string;
  completedAt?: number;
  subject?: string;
  description?: string;
}

interface MockDatabase {
  setTable(tableName: string, data: unknown[]): void;
  getTable(tableName: string): unknown[];
  exec(sql: string): void;
}

// Helper type for accessing mock database
const getDb = (manager: unknown): MockDatabase => {
  return (manager as { ledger: { getDb: () => unknown } }).ledger.getDb() as MockDatabase;
};

// Helper to create mock Dirent objects with proper type
type TestDirent = Dirent;
const createMockDirent = (name: string, isDir: boolean): TestDirent =>
  ({
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }) as unknown as TestDirent;

vi.mock("node:sqlite", () => {
  class MockDatabaseSync {
    private _path: string;
    private _isOpen: boolean = true;
    private _tables = new Map<string, unknown[]>();

    constructor(dbPath: string) {
      this._path = dbPath;
      this._tables.set("tasks", []);
      this._tables.set("members", []);
      this._tables.set("messages", []);
    }

    get path(): string {
      return this._path;
    }

    exec(_sql: string): void {}

    prepare(sql: string): unknown {
      const stmt = {
        sql,
        all: (...args: unknown[]) => {
          const tasks = this._tables.get("tasks") || [];
          const members = this._tables.get("members") || [];
          if (
            sql.includes("SELECT") &&
            sql.includes("FROM tasks") &&
            !sql.includes("WHERE status = ?")
          ) {
            return tasks;
          }
          if (sql.includes("SELECT") && sql.includes("FROM members")) {
            return members;
          }
          if (sql.includes("SELECT") && sql.includes("WHERE status = ?")) {
            const status = args[0] as string;
            const completedAt = args[1] as number;
            return tasks.filter((t: unknown) => {
              const task = t as MockTask;
              return task.status === status && task.completedAt && task.completedAt < completedAt;
            });
          }
          return [];
        },
        get: (...args: unknown[]) => {
          if (sql.includes("SELECT id")) {
            const tasks = this._tables.get("tasks") || [];
            const id = args[0] as string;
            return tasks.find((t: unknown) => (t as MockTask).id === id);
          }
          return null;
        },
        run: (...args: unknown[]) => {
          if (sql.includes("DELETE FROM tasks")) {
            const id = args[0] as string;
            const tasks = this._tables.get("tasks") || [];
            const index = tasks.findIndex((t: unknown) => (t as MockTask).id === id);
            if (index >= 0) {
              tasks.splice(index, 1);
            }
            return { changes: index >= 0 ? 1 : 0 };
          }
          if (sql.includes("UPDATE tasks SET status")) {
            const status = args[0] as string;
            const id = args[1] as string;
            const tasks = this._tables.get("tasks") || [];
            const task = tasks.find((t: unknown) => (t as MockTask).id === id) as
              | MockTask
              | undefined;
            if (task) {
              task.status = status;
              if (status === "completed") {
                task.completedAt = Date.now();
              }
            }
            return { changes: task ? 1 : 0 };
          }
          if (sql.includes("INSERT INTO tasks")) {
            const tasks = this._tables.get("tasks") || [];
            tasks.push({
              id: args[0],
              subject: args[1],
              description: args[2],
              status: "pending",
              completedAt: undefined,
            });
            return { changes: 1 };
          }
          if (sql.includes("INSERT INTO members")) {
            const members = this._tables.get("members") || [];
            members.push({
              sessionKey: args[0],
              agentId: args[1],
              name: args[2],
            });
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      };
      return stmt;
    }

    close(): void {
      this._isOpen = false;
    }

    get isOpen(): boolean {
      return this._isOpen;
    }

    getTable(tableName: string): unknown[] {
      return this._tables.get(tableName) || [];
    }

    setTable(tableName: string, data: unknown[]): void {
      this._tables.set(tableName, data);
    }
  }

  return {
    default: MockDatabaseSync,
    DatabaseSync: MockDatabaseSync,
  };
});

vi.mock("node:fs", () => ({
  mkdirSync: () => {},
}));

vi.mock("fs/promises");

describe("cleanupOldMessages", () => {
  const teamName = "test-team";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given a team with old messages", () => {
    it("When cleaning up messages older than maxAge Then it should delete them", async () => {
      const now = Date.now();
      const oldMessagesPath = path.join(stateDir, teamName, "inbox", "agent-1", "messages.jsonl");

      vi.mocked(fs.readdir).mockResolvedValue([
        createMockDirent("agent-1", true),
        createMockDirent("agent-2", true),
      ] as never);

      vi.mocked(fs.stat).mockImplementation(async (filePath) => {
        if (filePath === oldMessagesPath) {
          return { mtimeMs: now - 25 * 60 * 60 * 1000 } as Stats;
        }
        return { mtimeMs: now - 10 * 60 * 60 * 1000 } as Stats;
      });

      const deletedCount = await cleanupOldMessages(teamName, 24 * 60 * 60 * 1000, stateDir);

      expect(deletedCount).toBe(1);
      expect(vi.mocked(fs.unlink)).toHaveBeenCalledWith(oldMessagesPath);
    });
  });

  describe("Given a team with no old messages", () => {
    it("When cleaning up Then it should not delete any messages", async () => {
      const now = Date.now();

      vi.mocked(fs.readdir).mockResolvedValue([createMockDirent("agent-1", true)] as never);

      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: now - 10 * 60 * 60 * 1000 } as Stats);

      const deletedCount = await cleanupOldMessages(teamName, 24 * 60 * 60 * 1000, stateDir);

      expect(deletedCount).toBe(0);
      expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
    });
  });

  describe("Given a non-existent inbox directory", () => {
    it("When cleaning up Then it should handle gracefully", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));

      const deletedCount = await cleanupOldMessages(teamName, 24 * 60 * 60 * 1000, stateDir);

      expect(deletedCount).toBe(0);
    });
  });

  describe("Given mixed file types in inbox", () => {
    it("When cleaning up Then it should only process directories", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        createMockDirent("agent-1", true),
        createMockDirent(".DS_Store", false),
        createMockDirent("README.md", false),
      ] as never);

      vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as Stats);

      const deletedCount = await cleanupOldMessages(teamName, 24 * 60 * 60 * 1000, stateDir);

      expect(deletedCount).toBe(0);
    });
  });
});

describe("archiveCompletedTasks", () => {
  const teamName = "test-team";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given a team with old completed tasks", () => {
    it("When archiving tasks older than maxAge Then it should delete them", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      const now = Date.now();
      const oldTasks: MockTask[] = [
        { id: "1", status: "completed", completedAt: now - 35 * 24 * 60 * 60 * 1000 },
        { id: "2", status: "completed", completedAt: now - 40 * 24 * 60 * 60 * 1000 },
      ];
      const newTask: MockTask = {
        id: "3",
        status: "completed",
        completedAt: now - 5 * 24 * 60 * 60 * 1000,
      };

      db.setTable("tasks", [...oldTasks, newTask]);

      const archivedCount = await archiveCompletedTasks(
        teamName,
        30 * 24 * 60 * 60 * 1000,
        stateDir,
      );

      expect(archivedCount).toBe(2);
      const remainingTasks = db.getTable("tasks") as MockTask[];
      expect(remainingTasks).toHaveLength(1);
      expect(remainingTasks[0].id).toBe("3");
    });
  });

  describe("Given a team with no old completed tasks", () => {
    it("When archiving Then it should not delete any tasks", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      const now = Date.now();
      const tasks: MockTask[] = [
        { id: "1", status: "completed", completedAt: now - 5 * 24 * 60 * 60 * 1000 },
        { id: "2", status: "pending", completedAt: undefined },
      ];

      db.setTable("tasks", tasks);

      const archivedCount = await archiveCompletedTasks(
        teamName,
        30 * 24 * 60 * 60 * 1000,
        stateDir,
      );

      expect(archivedCount).toBe(0);
    });
  });

  describe("Given a team with only pending tasks", () => {
    it("When archiving Then it should not delete any tasks", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      const tasks: MockTask[] = [
        { id: "1", status: "pending", completedAt: undefined },
        { id: "2", status: "in_progress", completedAt: undefined },
      ];

      db.setTable("tasks", tasks);

      const archivedCount = await archiveCompletedTasks(
        teamName,
        30 * 24 * 60 * 60 * 1000,
        stateDir,
      );

      expect(archivedCount).toBe(0);
    });
  });

  describe("Given custom maxAge parameter", () => {
    it("When archiving with custom age Then it should use the custom threshold", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      const now = Date.now();
      const tasks: MockTask[] = [
        { id: "1", status: "completed", completedAt: now - 7 * 24 * 60 * 60 * 1000 },
        { id: "2", status: "completed", completedAt: now - 3 * 24 * 60 * 60 * 1000 },
      ];

      db.setTable("tasks", tasks);

      const archivedCount = await archiveCompletedTasks(
        teamName,
        5 * 24 * 60 * 60 * 1000,
        stateDir,
      );

      expect(archivedCount).toBe(1);
    });
  });
});

describe("cleanupInactiveTeams", () => {
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given teams with old update timestamps", () => {
    it("When identifying inactive teams Then it should return inactive team names", async () => {
      const now = Date.now();
      const teamConfigs = {
        "active-team": { updatedAt: now - 2 * 24 * 60 * 60 * 1000 },
        "inactive-team-1": { updatedAt: now - 10 * 24 * 60 * 60 * 1000 },
        "inactive-team-2": { updatedAt: now - 15 * 24 * 60 * 60 * 1000 },
      };

      vi.mocked(fs.readdir).mockResolvedValue(
        Object.keys(teamConfigs).map((name) => createMockDirent(name, true)) as never,
      );

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const teamName = path.basename(path.dirname(filePath as string));
        if (teamConfigs[teamName as keyof typeof teamConfigs]) {
          return JSON.stringify(teamConfigs[teamName as keyof typeof teamConfigs]);
        }
        throw new Error("Not found");
      });

      const inactiveTeams = await cleanupInactiveTeams(stateDir, 7 * 24 * 60 * 60 * 1000, false);

      expect(inactiveTeams).toEqual(["inactive-team-1", "inactive-team-2"]);
    });
  });

  describe("Given teams with deleteThreshold true", () => {
    it("When cleaning inactive teams Then it should delete team directories", async () => {
      const now = Date.now();
      const teamConfigs = {
        "active-team": { updatedAt: now - 2 * 24 * 60 * 60 * 1000 },
        "inactive-team": { updatedAt: now - 10 * 24 * 60 * 60 * 1000 },
      };

      vi.mocked(fs.readdir).mockResolvedValue(
        Object.keys(teamConfigs).map((name) => createMockDirent(name, true)) as never,
      );

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const teamName = path.basename(path.dirname(filePath as string));
        if (teamConfigs[teamName as keyof typeof teamConfigs]) {
          return JSON.stringify(teamConfigs[teamName as keyof typeof teamConfigs]);
        }
        throw new Error("Not found");
      });

      const inactiveTeams = await cleanupInactiveTeams(stateDir, 7 * 24 * 60 * 60 * 1000, true);

      expect(inactiveTeams).toEqual(["inactive-team"]);
      expect(vi.mocked(fs.rm)).toHaveBeenCalled();
    });
  });

  describe("Given a non-existent teams directory", () => {
    it("When cleaning inactive teams Then it should return empty array", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("ENOENT"));

      const inactiveTeams = await cleanupInactiveTeams(stateDir, 7 * 24 * 60 * 60 * 1000, false);

      expect(inactiveTeams).toEqual([]);
    });
  });

  describe("Given teams with missing config files", () => {
    it("When cleaning inactive teams Then it should skip teams without config", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        createMockDirent("team-with-config", true),
        createMockDirent("team-without-config", true),
      ] as never);

      const callCount = { value: 0 };
      vi.mocked(fs.readFile).mockImplementation(async () => {
        callCount.value++;
        if (callCount.value === 1) {
          return JSON.stringify({ updatedAt: Date.now() });
        }
        throw new Error("ENOENT");
      });

      const inactiveTeams = await cleanupInactiveTeams(stateDir, 7 * 24 * 60 * 60 * 1000, false);

      expect(inactiveTeams).toHaveLength(0);
    });
  });
});

describe("closeAllManagers", () => {
  const teamName1 = "test-team-1";
  const teamName2 = "test-team-2";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given multiple cached team managers", () => {
    it("When closing all managers Then it should close all cached instances", () => {
      const manager1 = getTeamManager(teamName1, stateDir);
      const manager2 = getTeamManager(teamName2, stateDir);

      expect(() => closeAllManagers()).not.toThrow();

      const newManager1 = getTeamManager(teamName1, stateDir);
      const newManager2 = getTeamManager(teamName2, stateDir);

      expect(newManager1).not.toBe(manager1);
      expect(newManager2).not.toBe(manager2);
    });
  });

  describe("Given no cached team managers", () => {
    it("When closing all managers Then it should not throw", () => {
      expect(() => closeAllManagers()).not.toThrow();
    });
  });
});

describe("closeTeamManager", () => {
  const teamName1 = "test-team-1";
  const teamName2 = "test-team-2";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given a cached team manager", () => {
    it("When closing a specific manager Then it should close only that instance", () => {
      const manager1 = getTeamManager(teamName1, stateDir);
      const manager2 = getTeamManager(teamName2, stateDir);

      closeTeamManager(teamName1);

      const newManager1 = getTeamManager(teamName1, stateDir);
      const sameManager2 = getTeamManager(teamName2, stateDir);

      expect(newManager1).not.toBe(manager1);
      expect(sameManager2).toBe(manager2);
    });
  });

  describe("Given a non-existent team manager", () => {
    it("When closing a non-existent manager Then it should not throw", () => {
      expect(() => closeTeamManager("non-existent-team")).not.toThrow();
    });
  });
});

describe("checkpointWAL", () => {
  const teamName = "test-team";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given a team with a WAL database", () => {
    it("When executing WAL checkpoint Then it should execute PRAGMA checkpoint", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      const execSpy = vi.spyOn(db, "exec");

      await checkpointWAL(teamName, stateDir);

      expect(execSpy).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE)");
    });
  });

  describe("Given multiple checkpoint calls", () => {
    it("When executing checkpoints multiple times Then each should execute PRAGMA", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      const execSpy = vi.spyOn(db, "exec");

      await checkpointWAL(teamName, stateDir);
      await checkpointWAL(teamName, stateDir);

      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(execSpy).toHaveBeenNthCalledWith(1, "PRAGMA wal_checkpoint(TRUNCATE)");
      expect(execSpy).toHaveBeenNthCalledWith(2, "PRAGMA wal_checkpoint(TRUNCATE)");
    });
  });
});

describe("getTeamStats", () => {
  const teamName = "test-team";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given a team with tasks, members, and messages", () => {
    it("When getting stats Then it should return accurate counts", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      db.setTable("tasks", [
        { id: "1", status: "completed", completedAt: Date.now() },
        { id: "2", status: "pending", completedAt: undefined },
        { id: "3", status: "in_progress", completedAt: undefined },
      ]);

      db.setTable("members", [
        { sessionKey: "agent-1", agentId: "agent-1", name: "Agent 1" },
        { sessionKey: "agent-2", agentId: "agent-2", name: "Agent 2" },
      ]);

      vi.mocked(fs.readdir).mockResolvedValue([createMockDirent("agent-1", true)] as never);

      vi.mocked(fs.readFile).mockResolvedValue('{"message":"test1"}\n{"message":"test2"}\n');

      vi.mocked(fs.stat).mockResolvedValue({ size: 4096 } as Stats);

      const stats = await getTeamStats(teamName, stateDir);

      expect(stats.taskCount).toBe(3);
      expect(stats.completedTaskCount).toBe(1);
      expect(stats.memberCount).toBe(2);
      expect(stats.messageCount).toBe(2);
      expect(stats.dbSize).toBe(4096);
    });
  });

  describe("Given a team with no messages", () => {
    it("When getting stats Then message count should be zero", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      db.setTable("tasks", [{ id: "1", status: "pending", completedAt: undefined }]);
      db.setTable("members", [{ sessionKey: "agent-1", agentId: "agent-1", name: "Agent 1" }]);

      vi.mocked(fs.readdir).mockResolvedValue([] as never);
      vi.mocked(fs.stat).mockResolvedValue({ size: 2048 } as Stats);

      const stats = await getTeamStats(teamName, stateDir);

      expect(stats.messageCount).toBe(0);
    });
  });

  describe("Given a team with no database file", () => {
    it("When getting stats Then dbSize should be zero", async () => {
      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      db.setTable("tasks", []);
      db.setTable("members", []);

      vi.mocked(fs.readdir).mockResolvedValue([] as never);
      vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));

      const stats = await getTeamStats(teamName, stateDir);

      expect(stats.dbSize).toBe(0);
    });
  });
});

describe("End-to-End Cleanup Workflow", () => {
  const teamName = "test-team";
  const stateDir = "/tmp/test-openclaw";

  beforeEach(() => {
    vi.clearAllMocks();
    closeAll();
  });

  afterEach(() => {
    closeAll();
  });

  describe("Given a complete cleanup workflow", () => {
    it("When running all cleanup operations Then they should complete in sequence", async () => {
      const now = Date.now();

      vi.mocked(fs.readdir).mockResolvedValue([createMockDirent("agent-1", true)] as never);

      vi.mocked(fs.stat).mockResolvedValue({
        mtimeMs: now - 30 * 60 * 60 * 1000,
        size: 2048,
      } as Stats);

      const manager = getTeamManager(teamName, stateDir);
      const db = getDb(manager);

      db.setTable("tasks", [
        { id: "1", status: "completed", completedAt: now - 35 * 24 * 60 * 60 * 1000 },
        { id: "2", status: "pending", completedAt: undefined },
      ]);

      db.setTable("members", [{ sessionKey: "agent-1", agentId: "agent-1", name: "Agent 1" }]);

      vi.mocked(fs.readFile).mockResolvedValue('{"message":"test"}\n');

      const messagesDeleted = await cleanupOldMessages(teamName, 24 * 60 * 60 * 1000, stateDir);
      const tasksArchived = await archiveCompletedTasks(
        teamName,
        30 * 24 * 60 * 60 * 1000,
        stateDir,
      );
      await checkpointWAL(teamName, stateDir);
      const stats = await getTeamStats(teamName, stateDir);

      expect(messagesDeleted).toBe(1);
      expect(tasksArchived).toBe(1);
      expect(stats.taskCount).toBe(1);
      expect(stats.completedTaskCount).toBe(0);
    });
  });
});
