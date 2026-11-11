import path from "node:path";
import { MessagePort } from "node:worker_threads";
import type {
  WorkerTaskChannel,
  WorkerTaskControl,
  WorkerTaskHandler,
} from "@openclaw/worker-runtime/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { createSqliteFamilyEngines } from "../infra/database-engine/selection-fixture.test-support.js";
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closePostgresPool } from "../infra/postgres-sync/pool.js";
import type { BridgeWorkerData } from "../infra/postgres-sync/protocol.js";
import {
  publishSqliteDatabaseAdmission,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import { getOpenClawStateFeatureSchemaSql } from "./openclaw-state-feature-schema.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

const mock = vi.hoisted(() => {
  vi.resetModules();
  return {
    handler:
      vi.fn<
        (
          input: unknown,
          channel?: WorkerTaskChannel,
          control?: WorkerTaskControl,
        ) => Promise<OpenClawStateReadReply>
      >(),
    control: {
      signal: new AbortController().signal,
      runNativeSection: async <T>(operation: () => T | Promise<T>) => operation(),
      throwIfCancelled: () => {},
    } satisfies WorkerTaskControl,
    open: vi.fn(),
    admit: vi.fn<() => void>(),
    query: vi.fn<() => []>(),
    settle: vi.fn<(operation: (source: { db: object }) => unknown) => unknown>(),
    unrelatedHandlerLoaded: false,
    database: undefined as object | undefined,
    bridges: [] as { online: Promise<void> }[],
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
          const online = new Promise<void>((resolve) => {
            this.once("online", () => resolve());
          });
          mock.bridges.push({ online });
        }
      }
    },
  };
});
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks: (handler: WorkerTaskHandler<OpenClawStateReadReply>) => {
    mock.handler.mockImplementation(async (input, channel, control) =>
      handler(input, channel, control ?? mock.control),
    );
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
// mock-isolation: Dispatch tests supply fixture handles without opening their synthetic source paths.
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  closeRetainedOpenClawStateReadConnections: vi.fn(),
  openOpenClawStateReadConnection: mock.open,
  readOpenClawStateReadOnlyLocation: mock.settle,
  withOpenClawStateReadOnlyLocation: vi.fn((operation: (source: { db: object }) => unknown) => {
    mock.admit();
    return operation({ db: mock.database ?? {} });
  }),
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
const readAtLocation = vi.mocked(withOpenClawStateReadOnlyLocation);

afterEach(async () => {
  await closePostgresPool();
  mock.bridges.length = 0;
});

beforeEach(() => {
  readAtLocation.mockClear();
  mock.control.signal = new AbortController().signal;
  mock.open.mockReset().mockImplementation(() => {
    throw new Error("Unexpected database open");
  });
  mock.database = undefined;
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
  {
    command: {
      type: "githubPublications.sharedObservation",
      input: {
        session: { agentId: "main", sessionKey: "agent:main:fixture", sessionId: "fixture" },
        selector: {},
        entry: {},
      },
    },
    tables: [],
    result: { row: undefined },
  },
  {
    command: { type: "workerEnvironments.snapshot", input: {} },
    tables: [
      "worker_environments",
      "worker_environment_credentials",
      "worker_environment_ssh_fallback_ports",
      "worker_environment_session_attachments",
    ],
    result: { facts: { ids: [], environments: [], credentials: [], attachments: [] } },
  },
  {
    command: { type: "workers.placementRecoveryCandidates", input: undefined },
    tables: [
      "worker_session_placements",
      "worker_workspace_pending_results",
      "worker_workspace_reconciliations",
    ],
    result: { candidates: [] },
  },
  {
    command: { type: "preparedPoolPresence.read", input: undefined },
    tables: ["config_machine_state"],
    result: { demand: undefined },
  },
  {
    command: { type: "sandboxRegistry.list", input: {} },
    tables: ["sandbox_registry_entries"],
    result: { entries: [] },
  },
] as const)(
  "reads startup $command.type without loading unrelated handlers",
  async ({ command, tables, result }) => {
    const db = openNodeSqliteDatabase(":memory:");
    mock.database = db;
    try {
      for (const table of tables) {
        db.exec(getOpenClawStateFeatureSchemaSql(table));
      }
      expect(await mock.handler({ ...request, command })).toEqual({
        ok: true,
        type: command.type,
        sourceAdmitted: true,
        ...result,
      });
      expect(mock.unrelatedHandlerLoaded).toBe(false);
    } finally {
      db.close();
    }
  },
);

it.each(["runtime", "runtime-discovery"] as const)(
  "reads the captured deletion snapshot for %s without loading unrelated handlers",
  async (purpose) => {
    const db = openNodeSqliteDatabase(":memory:");
    mock.database = db;
    const databasePath = path.resolve("/captured-state.sqlite");
    try {
      db.exec(getOpenClawStateFeatureSchemaSql("agent_deletion_journal"));
      db.prepare(`INSERT INTO agent_deletion_journal
        (agent_id, agent_dir, workspace_dir, sessions_dir, created_at, phase)
        VALUES ('retired', '/fixture/retired', '/fixture/workspace', '/fixture/sessions', 1, 'pending')`).run();
      expect(
        await mock.handler({
          ...request,
          databasePath,
          command: { type: "agentDatabaseDeletion.snapshot", purpose },
        }),
      ).toEqual({
        ok: true,
        type: "agentDatabaseDeletion.snapshot",
        sourceAdmitted: true,
        snapshot: {
          deletedAgents: [{ agentId: "retired", status: "pending" }],
          registeredAgentDatabases: [],
          retainedDeletions:
            purpose === "runtime"
              ? { status: "empty" }
              : {
                  status: "present",
                  entries: [
                    {
                      agentId: "retired",
                      agentDir: "/fixture/retired",
                      databasePaths: [path.join("/fixture/retired", "openclaw-agent.sqlite")],
                      cleanupCompleted: false,
                    },
                  ],
                  held: [],
                },
        },
      });
      expect(mock.query).toHaveBeenCalledExactlyOnceWith(db, databasePath, false);
      expect(readAtLocation.mock.calls[0]?.[8], "captured quarantine store admission").toBe(
        path.resolve("/fixture", "state", "openclaw-quarantine.sqlite"),
      );
      expect(mock.unrelatedHandlerLoaded).toBe(false);
    } finally {
      db.close();
    }
  },
);

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
    effectiveEngines: createSqliteFamilyEngines({ state: "postgres" }),
    postgres: { connection: "postgresql://[unused", schemaPrefix: "fixture" },
  };
  const connections: Int32Array[] = [];
  // oxlint-disable-next-line typescript/unbound-method
  const post = MessagePort.prototype.postMessage;
  const postMessage = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    ...args
  ) {
    const data = args[0] as { connection?: BridgeWorkerData };
    if (data.connection) {
      connections.push(new Int32Array(data.connection.signal));
    }
    return Reflect.apply(post, this, args);
  });
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
    expect(mock.bridges).toHaveLength(4);
    await Promise.all(mock.bridges.map(({ online }) => online));
    expect(connections).toHaveLength(1);
    expect(Atomics.load(connections[0]!, 0)).toBe(0);
    mock.bootstrapRelease.resolve();
    await expect(reading).resolves.toMatchObject({ ok: true, type: "stateBootstrap.inspect" });
    expect(connections).toHaveLength(1);
    expect(mock.bridges).toHaveLength(4);
  } finally {
    mock.bootstrapRelease.resolve();
    await reading;
    postMessage.mockRestore();
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

describe.each([
  { type: "subagents.restore" },
  {
    type: "meetingTranscripts.export",
    format: "library",
    selector: "fixture-session",
    includeNotes: true,
  },
] as const)("$type stream loading", (command) => {
  const loaded = new Set<string>();
  const freshAdmission = vi.fn<() => void>();
  const nativeSection = vi.fn();
  const restore =
    vi.fn<
      typeof import("../agents/subagents/registry/subagent-registry.store.restore.worker.js").streamSubagentRegistryInWorker
    >();
  const exportTranscript =
    vi.fn<typeof import("../transcripts/store-export.worker.js").streamTranscriptExportInWorker>();
  const channel: WorkerTaskChannel = {
    consumeInput: vi.fn(),
    notify: vi.fn(),
    request: vi.fn<WorkerTaskChannel["request"]>(),
  };
  const control: WorkerTaskControl = {
    signal: new AbortController().signal,
    runNativeSection: async <T>(operation: () => T | Promise<T>) => {
      nativeSection();
      return operation();
    },
    throwIfCancelled: () => {},
  };
  let holdImport = false;
  let importStarted: PromiseWithResolvers<void>;
  let releaseImport: PromiseWithResolvers<void>;

  beforeEach(async () => {
    control.signal = new AbortController().signal;
    // Each command must start cold, including Vitest's separate mock-module cache.
    vi.resetModules();
    loaded.clear();
    holdImport = false;
    importStarted = Promise.withResolvers<void>();
    releaseImport = Promise.withResolvers<void>();
    freshAdmission.mockReset();
    nativeSection.mockReset();
    restore.mockReset().mockImplementation(async (_input, _channel, onAdmitted) => {
      onAdmitted();
      return 2;
    });
    exportTranscript
      .mockReset()
      .mockImplementation(async (_input, _command, _channel, onAdmitted) => {
        onAdmitted();
        return { ok: true };
      });
    vi.doMock("./openclaw-state-read-handlers.js", async (importOriginal) => {
      loaded.add("catchall");
      return importOriginal<typeof import("./openclaw-state-read-handlers.js")>();
    });
    vi.doMock(
      "../agents/subagents/registry/subagent-registry.store.worker.js",
      async (importOriginal) => {
        loaded.add("mixed-store");
        return importOriginal<
          typeof import("../agents/subagents/registry/subagent-registry.store.worker.js")
        >();
      },
    );
    vi.doMock(
      "../agents/subagents/registry/subagent-registry.store.restore.worker.js",
      async (importOriginal) => {
        loaded.add("subagents.restore");
        if (holdImport && command.type === "subagents.restore") {
          importStarted.resolve();
          await releaseImport.promise;
        }
        return {
          ...(await importOriginal<
            typeof import("../agents/subagents/registry/subagent-registry.store.restore.worker.js")
          >()),
          streamSubagentRegistryInWorker: restore,
        };
      },
    );
    vi.doMock("../transcripts/store-export.worker.js", async (importOriginal) => {
      loaded.add("meetingTranscripts.export");
      if (holdImport && command.type === "meetingTranscripts.export") {
        importStarted.resolve();
        await releaseImport.promise;
      }
      return {
        ...(await importOriginal<typeof import("../transcripts/store-export.worker.js")>()),
        streamTranscriptExportInWorker: exportTranscript,
      };
    });
    const { openClawStateDatabaseCache } = await import("./openclaw-state-db-cache.js");
    vi.spyOn(
      openClawStateDatabaseCache,
      "assertOpenClawStateDatabaseFreshOpenAllowedAtPath",
    ).mockImplementation(freshAdmission);
    await import("./openclaw-state-read.worker.js");
  });

  afterEach(() => {
    releaseImport.resolve();
    vi.doUnmock("./openclaw-state-read-handlers.js");
    vi.doUnmock("../agents/subagents/registry/subagent-registry.store.worker.js");
    vi.doUnmock("../agents/subagents/registry/subagent-registry.store.restore.worker.js");
    vi.doUnmock("../transcripts/store-export.worker.js");
    vi.restoreAllMocks();
  });

  it("loads only its stream owner and preserves the reply", async () => {
    const input = { ...request, checkFreshAdmission: true, command };
    const reply = await mock.handler(input, channel, control);
    expect(reply).toEqual(
      command.type === "subagents.restore"
        ? { ok: true, type: command.type, sourceAdmitted: true, count: 2 }
        : { ok: true, type: command.type, sourceAdmitted: true, result: { ok: true } },
    );
    if (command.type === "subagents.restore") {
      expect(restore).toHaveBeenCalledExactlyOnceWith(input, channel, expect.any(Function));
      expect(exportTranscript).not.toHaveBeenCalled();
    } else {
      expect(exportTranscript).toHaveBeenCalledExactlyOnceWith(
        input,
        command,
        channel,
        expect.any(Function),
      );
      expect(restore).not.toHaveBeenCalled();
    }
    expect(freshAdmission).toHaveBeenCalledOnce();
    expect(nativeSection).toHaveBeenCalledOnce();
    expect(loaded).toEqual(new Set([command.type]));
  });

  it("requires a receiver before entering either stream owner", async () => {
    const reply = await mock.handler({ ...request, command }, undefined, control);
    const operation =
      command.type === "subagents.restore" ? "Subagent restore" : "Transcript export";
    expect(reply).toMatchObject({
      ok: false,
      message: `${operation} requires a bounded receiver`,
      sourceAdmitted: undefined,
    });
    expect(restore).not.toHaveBeenCalled();
    expect(exportTranscript).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
  });

  it("checks fresh admission after the pending owner import settles", async () => {
    holdImport = true;
    const pending = mock.handler(
      { ...request, checkFreshAdmission: true, command },
      channel,
      control,
    );
    let reply: OpenClawStateReadReply | undefined;
    try {
      await Promise.race([
        importStarted.promise,
        pending.then(() => {
          throw new Error("Worker returned before loading the selected stream owner");
        }),
      ]);
      expect(freshAdmission).not.toHaveBeenCalled();
      freshAdmission.mockImplementation(() => {
        throw new Error("Fresh source admission refused");
      });
    } finally {
      releaseImport.resolve();
      reply = await pending;
    }
    expect(reply).toMatchObject({
      ok: false,
      message: "Fresh source admission refused",
      sourceAdmitted: undefined,
    });
    expect(freshAdmission).toHaveBeenCalledOnce();
    expect(nativeSection).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(exportTranscript).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
  });
});
