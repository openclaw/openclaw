import { beforeEach, expect, it, vi } from "vitest";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

const mock = vi.hoisted(() => ({
  handler: vi.fn<(input: unknown) => Promise<OpenClawStateReadReply>>(),
  admit: vi.fn<() => void>(),
  query: vi.fn<() => []>(),
  settle: vi.fn<(operation: (source: { db: object }) => unknown) => unknown>(),
  unrelatedHandlerLoaded: false,
}));
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks: (handler: (input: unknown) => Promise<OpenClawStateReadReply>) => {
    mock.handler.mockImplementation(handler);
  },
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
    return undefined;
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
  context: {
    environment: { OPENCLAW_STATE_DIR: "/fixture" },
  },
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

it("reads plugin metadata without loading unrelated command handlers", async () => {
  const reply = await mock.handler({
    ...request,
    command: {
      type: "plugins.metadata.read",
      input: { stateKeys: ["plugins.bundledDiscovery"] },
    },
  });
  expect(reply).toEqual({
    ok: true,
    type: "plugins.metadata.read",
    sourceAdmitted: true,
    rows: [{ state_key: "plugins.bundledDiscovery", value_json: '"allowlist"' }],
  });
  expect(mock.unrelatedHandlerLoaded).toBe(false);
});

it("reads the ownership lease without loading unrelated command handlers", async () => {
  const reply = await mock.handler({
    ...request,
    command: { type: "gatewayOwnerLease.read", schemaMaintenance: false },
  });
  expect(reply).toEqual({
    ok: true,
    type: "gatewayOwnerLease.read",
    sourceAdmitted: true,
    lease: undefined,
  });
  expect(mock.unrelatedHandlerLoaded).toBe(false);
});

it.each([
  { type: "backup.runs", outcome: "query-error" },
  { type: "backup.runs", outcome: "schema-error" },
  { type: "agentDatabaseRegistry.read", outcome: "success" },
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
    expect(reply).toEqual({
      ok: true,
      type,
      sourceAdmitted,
      result:
        outcome === "success" ? { status: "available", entries: [] } : { status: "unavailable" },
    });
  }
  expect(mock.query).toHaveBeenCalledTimes(outcome === "schema-error" ? 0 : 1);
});
