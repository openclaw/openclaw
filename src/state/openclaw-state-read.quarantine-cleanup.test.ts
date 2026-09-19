import assert from "node:assert/strict";
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
  claimAgentLease: vi.fn(() => "quarantine-test-lease"),
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
vi.mock("./openclaw-agent-db-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-agent-db-lease.js")>()),
  claimOpenClawAgentDatabaseLease: mock.claimAgentLease,
  releaseOpenClawAgentDatabaseLease: vi.fn(),
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  withOpenClawStateReadOnlyLocation: (operation: (source: { db: object }) => unknown) =>
    operation({ db: {} }),
}));

import "./openclaw-state-read.worker.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
beforeEach(() => {
  mock.databases.length = 0;
  mock.read.mockReset().mockReturnValue({ user_version: 0 });
  mock.close.mockReset();
  mock.query.mockReset().mockReturnValue([]);
  mock.claimAgentLease.mockClear();
  mock.open.mockReset().mockImplementation((location) => {
    if (!location.endsWith("openclaw-quarantine.sqlite")) {
      throw new Error(`Unexpected source database open: ${location}`);
    }
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

function knownQuarantine(kind: "state" | "agent") {
  const reason = "verified synthetic database damage";
  mock.read.mockImplementation((sql) =>
    sql === "PRAGMA user_version"
      ? { user_version: 2 }
      : { kind, reason, quarantined_at: 1, verified_generation: null },
  );
  return reason;
}

it("refuses a known state quarantine when metadata cleanup fails before source admission", () => {
  const input = request();
  const reason = knownQuarantine("state");
  const closeFailure = new Error("quarantine reader close failed after a valid decision");
  mock.close.mockImplementationOnce(() => {
    throw closeFailure;
  });

  const reply = mock.handler(input);
  expect(reply).toMatchObject({
    ok: false,
    message: expect.stringContaining(reason),
    nativeCleanupFailure: {
      error: {
        nodes: expect.arrayContaining([expect.objectContaining({ message: closeFailure.message })]),
      },
    },
  });
  assert(!reply.ok);
  expect(reply.sourceAdmitted).toBeUndefined();
  expect(mock.query).not.toHaveBeenCalled();
  expect(mock.close).toHaveBeenCalledOnce();
});

it("latches a known agent quarantine before opening its database when metadata cleanup fails", () => {
  const input = request();
  const reason = knownQuarantine("agent");
  const closeFailure = new Error("agent quarantine reader close failed after a valid decision");
  mock.close.mockImplementationOnce(() => {
    throw closeFailure;
  });
  const agentPath = path.join(path.dirname(input.databasePath), "openclaw-agent.sqlite");
  fs.writeFileSync(agentPath, "mock agent source");
  const options = {
    agentId: "quarantined-agent",
    path: agentPath,
    env: input.context.environment,
  };
  let failure: unknown;
  try {
    openOpenClawAgentDatabase(options);
  } catch (error) {
    failure = error;
  }
  expect(mock.open.mock.calls[0]?.[0]).toContain("openclaw-quarantine.sqlite");
  expect(mock.read).toHaveBeenCalledWith(expect.stringContaining("SELECT kind, reason"));
  expect(mock.close).toHaveBeenCalledOnce();
  assert(failure instanceof Error);
  expect(failure).toMatchObject({
    name: "SqliteIntegrityError",
    message: expect.stringContaining(reason),
    cause: { errors: [closeFailure] },
  });
  expect(mock.claimAgentLease).not.toHaveBeenCalled();
  expect(mock.open).toHaveBeenCalledOnce();
  expect(mock.open.mock.calls[0]?.[0]).toContain("openclaw-quarantine.sqlite");

  // The existing latch must refuse the same file without another metadata read.
  mock.open.mockClear();
  expect(() => openOpenClawAgentDatabase(options)).toThrow(failure);
  expect(mock.open).not.toHaveBeenCalled();
});

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
