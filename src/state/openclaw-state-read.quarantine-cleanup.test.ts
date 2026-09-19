import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

type FakeDatabase = {
  isOpen: boolean;
  exec: () => void;
  prepare: (sql: string) => { get: () => unknown };
  close: () => void;
};
const mock = vi.hoisted(() => ({
  handler: vi.fn<(input: unknown) => OpenClawStateReadReply>(),
  open: vi.fn<(location: string) => FakeDatabase>(),
  read: vi.fn<(sql: string) => unknown>(),
  close: vi.fn<() => void>(),
  query: vi.fn<() => []>(),
  databases: [] as FakeDatabase[],
}));
vi.mock("../infra/worker-task-pool.js", () => ({
  serveWorkerTasks: (handler: (input: unknown) => OpenClawStateReadReply) => {
    mock.handler.mockImplementation(handler);
  },
}));
vi.mock("../infra/node-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/node-sqlite.js")>()),
  openNodeSqliteDatabase: mock.open,
}));
vi.mock("../fleet/registry.kernel.js", () => ({
  listFleetCellsInDatabase: mock.query,
  getFleetCellInDatabase: () => undefined,
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  withOpenClawStateReadOnlyLocation: (operation: (source: { db: object }) => unknown) =>
    operation({ db: {} }),
}));

import "./openclaw-state-read.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mock.databases.length = 0;
  mock.read.mockReset().mockReturnValue({ user_version: 0 });
  mock.close.mockReset();
  mock.query.mockReset().mockReturnValue([]);
  mock.open.mockReset().mockImplementation(() => {
    const database: FakeDatabase = {
      isOpen: true,
      exec() {},
      prepare: (sql) => ({ get: () => mock.read(sql) }),
      close() {
        mock.close();
        database.isOpen = false;
      },
    };
    mock.databases.push(database);
    return database;
  });
});

function request(): OpenClawStateReadRequest {
  const root = tempDirs.make("openclaw-quarantine-cleanup-");
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  // Only existence/identity are real; every SQLite connection is a plain mocked object.
  fs.writeFileSync(path.join(state, "openclaw-quarantine.sqlite"), "mock quarantine store");
  const databasePath = path.join(state, "openclaw.sqlite");
  fs.writeFileSync(databasePath, "mock state source");
  return {
    context: {
      environment: { OPENCLAW_STATE_DIR: root },
      coordinatorRuntime: { directory: path.join(root, "coordinator"), keepAlive: false },
    },
    databasePath,
    location: databasePath,
    checkFreshAdmission: true,
    command: { type: "fleet.list" },
  };
}

it.each([false, true])(
  "reports unsettled quarantine cleanup without changing the best-effort read result (read also fails=%s)",
  (readFails) => {
    const readFailure = new Error("quarantine metadata read failed");
    const closeFailure = new Error("quarantine native reader close failed");
    if (readFails) {
      mock.read.mockImplementationOnce(() => {
        throw readFailure;
      });
    }
    mock.close.mockImplementationOnce(() => {
      throw closeFailure;
    });
    const reply = mock.handler(request());
    expect(reply).toMatchObject({
      ok: true,
      type: "fleet.list",
      cells: [],
      nativeCleanupFailure: {
        error: {
          nodes: expect.arrayContaining([
            expect.objectContaining({ message: closeFailure.message }),
            ...(readFails ? [expect.objectContaining({ message: readFailure.message })] : []),
          ]),
        },
      },
    });
    expect(mock.query).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
    expect(mock.databases[0]?.isOpen).toBe(true);
  },
);

it("keeps ordinary quarantine metadata failures best effort after a successful native close", () => {
  mock.read.mockImplementationOnce(() => {
    throw new Error("quarantine metadata unavailable");
  });
  expect(mock.handler(request())).toEqual({
    ok: true,
    type: "fleet.list",
    sourceAdmitted: true,
    cells: [],
  });
  expect(mock.query).toHaveBeenCalledOnce();
  expect(mock.close).toHaveBeenCalledOnce();
  expect(mock.databases[0]?.isOpen).toBe(false);
});
