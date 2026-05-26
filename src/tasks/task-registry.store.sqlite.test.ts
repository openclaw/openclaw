import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeTaskRegistrySqliteStore,
  loadTaskRegistryStateFromSqlite,
} from "./task-registry.store.sqlite.js";

vi.mock("../infra/sqlite-wal.js", () => ({
  configureSqliteWalMaintenance: vi.fn(() => ({
    checkpoint: () => true,
    close: () => true,
  })),
}));

let mockDatabaseSyncCtor: ReturnType<typeof vi.fn> = vi.fn();

vi.mock("../infra/node-sqlite.js", () => ({
  requireNodeSqlite: vi.fn(() => ({
    DatabaseSync: mockDatabaseSyncCtor,
  })),
}));

describe("task-registry sqlite snapshot restore", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    closeTaskRegistrySqliteStore();
    vi.restoreAllMocks();
  });

  it("falls back to a read-only database open when the writable open hits a readonly sqlite error", () => {
    const stateDir = path.join(os.tmpdir(), `openclaw-task-registry-readonly-${process.pid}-${Date.now()}`);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mkdirSync(path.join(stateDir, "tasks"), { recursive: true });
    writeFileSync(path.join(stateDir, "tasks", "runs.sqlite"), "");

    const selectAll = { all: vi.fn(() => []) };
    const selectAllDeliveryStates = {
      all: vi.fn(() => [
        {
          task_id: "task-ro",
          requester_origin_json: null,
          last_notified_event_at: null,
        },
      ]),
    };

    mockDatabaseSyncCtor = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error("attempt to write a readonly database") as NodeJS.ErrnoException & {
          errstr?: string;
        };
        err.code = "ERR_SQLITE_ERROR";
        err.errstr = "attempt to write a readonly database";
        throw err;
      })
      .mockImplementationOnce((_path: string, options?: { readOnly?: boolean }) => {
        expect(options?.readOnly).toBe(true);
        return {
          prepare: vi.fn((sql: string) => {
            if (sql.includes("FROM task_runs")) {
              return selectAll;
            }
            if (sql.includes("FROM task_delivery_state")) {
              return selectAllDeliveryStates;
            }
            throw new Error(`Unexpected prepare SQL: ${sql}`);
          }),
          close: vi.fn(),
        };
      });

    const snapshot = loadTaskRegistryStateFromSqlite();

    expect(mockDatabaseSyncCtor).toHaveBeenCalledTimes(2);
    expect(snapshot.tasks.size).toBe(0);
    expect(snapshot.deliveryStates.get("task-ro")?.taskId).toBe("task-ro");
    expect(selectAll.all).toHaveBeenCalledTimes(1);
    expect(selectAllDeliveryStates.all).toHaveBeenCalledTimes(1);
  });
});
