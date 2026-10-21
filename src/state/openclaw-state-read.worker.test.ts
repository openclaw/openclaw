import { beforeEach, expect, it, vi } from "vitest";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

const mock = vi.hoisted(() => {
  vi.resetModules();
  return {
    handler: vi.fn<(input: unknown) => Promise<OpenClawStateReadReply>>(),
    admit: vi.fn<() => void>(),
    query: vi.fn<() => []>(),
    settle: vi.fn<(operation: (source: { db: object }) => unknown) => unknown>(),
    unrelatedHandlerLoaded: false,
  };
});
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks: mock.handler.mockImplementation.bind(mock.handler),
}));
vi.mock("./backup-run-records.kernel.js", async (importOriginal) => {
  mock.unrelatedHandlerLoaded = true;
  return {
    ...(await importOriginal<typeof import("./backup-run-records.kernel.js")>()),
    readBackupRunsInDatabase: mock.query,
  };
});
vi.mock("../plugins/plugin-metadata-state.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-state.kernel.js")>()),
  readPluginMetadataStateRowsInDatabase: () => [
    { state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' },
  ],
}));
vi.mock("./openclaw-agent-db-registry.read.js", () => ({
  readRegisteredAgentDatabaseRows: mock.query,
}));
vi.mock("../infra/gateway-owner-lease.worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-owner-lease.worker.js")>()),
  inspectGatewayOwnerLease: (_source: unknown, onAdmitted: () => void) => {
    onAdmitted();
  },
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
  context: { environment: { OPENCLAW_STATE_DIR: "/fixture" } },
  databasePath: "/fixture/state.sqlite",
  location: "/fixture/snapshot.sqlite",
  checkFreshAdmission: false,
  command: { type: "backup.runs" },
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

it.each([
  [
    { type: "plugins.metadata.read", input: { stateKeys: ["plugins.bundledDiscovery"] } },
    { rows: [{ state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' }] },
  ],
  [{ type: "gatewayOwnerLease.read", schemaMaintenance: false }, { lease: undefined }],
  [{ type: "agentDatabaseRegistry.read" }, { result: { status: "available", entries: [] } }],
] as const)("reads %j without loading unrelated handlers", async (command, result) => {
  const reply = await mock.handler({ ...request, command });
  expect(reply).toEqual({ ok: true, type: command.type, sourceAdmitted: true, ...result });
  if (command.type === "agentDatabaseRegistry.read") {
    expect(mock.query).toHaveBeenCalledExactlyOnceWith({}, request.databasePath, false);
  }
  expect(mock.unrelatedHandlerLoaded).toBe(false);
});

it.each([
  { type: "backup.runs", outcome: "query-error" },
  { type: "backup.runs", outcome: "schema-error" },
  { type: "agentDatabaseRegistry.read", outcome: "query-error" },
  { type: "agentDatabaseRegistry.read", outcome: "schema-error" },
  { type: "agentDatabaseRegistry.read", outcome: "cleanup-error" },
] as const)("reports $type admission and cleanup for $outcome", async ({ type, outcome }) => {
  const failure = new Error("controlled reader failure");
  const fail = () => {
    throw failure;
  };
  if (outcome === "schema-error") {
    mock.admit.mockImplementation(fail);
  }
  if (outcome === "query-error") {
    mock.query.mockImplementation(fail);
  }
  if (outcome === "cleanup-error") {
    mock.settle.mockImplementationOnce((operation) => {
      operation({ db: {} });
      throw failure;
    });
  }
  const reply = await mock.handler({ ...request, command: { type } });
  const sourceAdmitted = outcome === "schema-error" ? undefined : true;
  if (type === "backup.runs" || outcome === "cleanup-error") {
    expect(reply).toMatchObject({ ok: false, message: failure.message, sourceAdmitted });
  } else {
    expect(reply).toEqual({ ok: true, type, sourceAdmitted, result: { status: "unavailable" } });
  }
  expect(mock.query).toHaveBeenCalledTimes(outcome === "schema-error" ? 0 : 1);
});
