import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  publishSqliteDatabaseAdmission,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
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
    bridges: [] as { worker: Worker; control: Int32Array; online: Promise<void> }[],
    bootstrapLoading: Promise.withResolvers<void>(),
    bootstrapRelease: Promise.withResolvers<void>(),
  };
});
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        if (String(args[0]).includes("postgres-sync/bridge.worker")) {
          const data = args[1]?.workerData as { signal: SharedArrayBuffer };
          const online = new Promise<void>((resolve) => {
            this.once("online", () => resolve());
          });
          mock.bridges.push({ worker: this, control: new Int32Array(data.signal), online });
        }
      }
    },
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
// mock-isolation: Hold command-module loading until the early bridge startup has been observed.
vi.mock("./state-bootstrap-read.worker.js", async () => {
  mock.bootstrapLoading.resolve();
  await mock.bootstrapRelease.promise;
  return {
    stateBootstrapReadOperations: {
      "stateBootstrap.inspect": () => ({
        type: "stateBootstrap.inspect",
        inspection: { schemas: { incompatible: [], indeterminate: [] }, inspectionErrors: [] },
      }),
    },
  };
});
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await Promise.all(mock.bridges.splice(0).map(({ worker }) => worker.terminate()));
});

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

it("starts its PG bridge while the first command module is still loading", async () => {
  const databasePath = path.join(tempDirs.make("state-reader-bridge-prestart-"), "state.sqlite");
  const anchor = openNodeSqliteDatabase(databasePath);
  const facts: PostgresPhysicalFacts = {
    engine: "postgres",
    admissionId: "state-admission",
    store: "state",
    namespace: "state_reader_fixture",
    storeId: "state-store",
    version: 29,
    capabilities: { serverMajor: 17, serverEncoding: "UTF8", clientEncoding: "UTF8" },
    catalog: [],
  };
  publishSqliteDatabaseAdmission(
    anchor,
    { name: "database.engine.schema", schemaDependent: true },
    facts,
  );
  const selection: DatabaseEngineSelection = {
    effectiveEngines: {
      state: "postgres",
      agent: "sqlite",
      workboard: "sqlite",
      logbook: "sqlite",
      "team-reports": "sqlite",
      quarantine: "sqlite",
      "managed-update": "sqlite",
      "package-activation": "sqlite",
    },
    postgres: { connection: "postgresql://[unused", schemaPrefix: "fixture" },
  };
  const reading = mock.handler({
    ...request,
    databasePath,
    location: databasePath,
    context: { ...request.context, databaseEngineSelection: selection },
    command: {
      type: "stateBootstrap.inspect",
      input: { pathname: databasePath, supportedVersion: 29, scope: "state", purpose: "runtime" },
    },
  });
  try {
    await mock.bootstrapLoading.promise;
    expect(mock.bridges).toHaveLength(1);
    await mock.bridges[0]!.online;
    expect(Atomics.load(mock.bridges[0]!.control, 0)).toBe(0);
    mock.bootstrapRelease.resolve();
    await expect(reading).resolves.toMatchObject({ ok: true, type: "stateBootstrap.inspect" });
    expect(mock.bridges).toHaveLength(1);
  } finally {
    mock.bootstrapRelease.resolve();
    await reading;
    anchor.close();
    retireSqliteDatabaseAdmissionForPath(databasePath);
  }
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
