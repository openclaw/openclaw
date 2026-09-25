import { beforeEach, expect, it, vi } from "vitest";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

const mock = vi.hoisted(() => ({
  handler: vi.fn<(input: unknown) => OpenClawStateReadReply>(),
  admit: vi.fn<() => void>(),
  query: vi.fn<() => []>(),
  settle: vi.fn<(operation: (source: { db: object }) => unknown) => unknown>(),
}));
vi.mock("../infra/worker-task-server.js", () => ({
  serveOwnedWorkerTasks: (handler: (input: unknown) => OpenClawStateReadReply) => {
    mock.handler.mockImplementation(handler);
  },
}));
vi.mock("../fleet/registry.kernel.js", () => ({
  listFleetCellsInDatabase: mock.query,
  getFleetCellInDatabase: () => undefined,
}));
vi.mock("./openclaw-agent-db-registry.read.js", () => ({
  readRegisteredAgentDatabaseRows: mock.query,
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  closeRetainedOpenClawStateReadConnections: vi.fn(),
  readOpenClawStateReadOnlyLocation: mock.settle,
  withOpenClawStateReadOnlyLocation: (operation: (source: { db: object }) => unknown) => {
    mock.admit();
    return operation({ db: {} });
  },
}));

import "./openclaw-state-read.worker.js";

const request: OpenClawStateReadRequest = {
  context: {
    environment: { OPENCLAW_STATE_DIR: "/fixture" },
    coordinatorRuntime: { directory: "/fixture/coordinator", keepAlive: false },
  },
  databasePath: "/fixture/state.sqlite",
  location: "/fixture/snapshot.sqlite",
  checkFreshAdmission: false,
  command: { type: "fleet.list" },
};

beforeEach(() => {
  mock.admit.mockReset();
  mock.query.mockReset().mockReturnValue([]);
  mock.settle.mockReset().mockImplementation((operation) => {
    try {
      mock.admit();
      return { status: "available", value: operation({ db: {} }) };
    } catch (error) {
      return { status: "unavailable", error };
    }
  });
});

it.each(["success", "query-error", "schema-error"] as const)(
  "reports source admission at the schema-validated callback for %s",
  (outcome) => {
    const failure = new Error("controlled reader failure");
    if (outcome === "schema-error") {
      mock.admit.mockImplementation(() => {
        throw failure;
      });
    } else if (outcome === "query-error") {
      mock.query.mockImplementation(() => {
        throw failure;
      });
    }
    const reply = mock.handler(request);
    if (reply.ok) {
      expect(reply).toEqual({ ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] });
    } else {
      expect(reply.message).toBe(failure.message);
      expect(reply.sourceAdmitted).toBe(outcome === "query-error" ? true : undefined);
    }
    expect(reply.ok).toBe(outcome === "success");
    expect(mock.query).toHaveBeenCalledTimes(outcome === "schema-error" ? 0 : 1);
  },
);

it.each(["success", "query-error", "schema-error"] as const)(
  "preserves native admission facts in the registry %s reply",
  (outcome) => {
    const fail = () => {
      throw new Error("read unavailable");
    };
    if (outcome === "schema-error") {
      mock.admit.mockImplementation(fail);
    }
    if (outcome === "query-error") {
      mock.query.mockImplementation(fail);
    }
    expect(mock.handler({ ...request, command: { type: "agentDatabaseRegistry.read" } })).toEqual({
      ok: true,
      type: "agentDatabaseRegistry.read",
      sourceAdmitted: outcome === "schema-error" ? undefined : true,
      result:
        outcome === "success" ? { status: "available", entries: [] } : { status: "unavailable" },
    });
  },
);

it("keeps registry native cleanup failure in the worker error protocol", () => {
  mock.settle.mockImplementationOnce((operation) => {
    operation({ db: {} });
    throw new Error("native cleanup failed");
  });
  const reply = mock.handler({ ...request, command: { type: "agentDatabaseRegistry.read" } });
  expect(reply).toMatchObject({
    ok: false,
    sourceAdmitted: true,
    message: "native cleanup failed",
  });
});
