import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withBackupFixture, withDatabase } from "./backup-create-family.test-support.js";
import {
  classifyBackupSqliteSource,
  createBackupSqliteSnapshotPlan,
} from "./backup-sqlite-snapshot.js";
import * as sqliteHeaderProbe from "./sqlite-header-probe.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

const mocks = vi.hoisted(() => ({ exportPostgres: vi.fn() }));
// The PostgreSQL worker is the external fixture; SQLite capture and planning stay real.
vi.mock("../snapshot/database-backup.js", async (original) => ({
  ...(await original<typeof import("../snapshot/database-backup.js")>()),
  capturePostgresBackup: mocks.exportPostgres,
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.exportPostgres.mockReset();
});

type ExportParams = { sourcePath: string; directory: string };
type ExportOptions = { signal?: AbortSignal } | undefined;

// Shared state on PostgreSQL: the live file is an anchor and the export carries the registry.
async function preparePostgresState(
  state: OpenClawTestState,
  editRegistry?: (mainAgentPath: string) => Promise<void> | void,
) {
  const globalPath = resolveOpenClawStateSqlitePath(state.env);
  const mainAgentPath = path.join(state.agentDir("main"), "openclaw-agent.sqlite");
  openOpenClawStateDatabase({ env: state.env });
  openOpenClawAgentDatabase({ agentId: "main", path: mainAgentPath, env: state.env });
  await editRegistry?.(mainAgentPath);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabase();
  const exportedImage = state.path("exported-state.sqlite");
  await fs.copyFile(globalPath, exportedImage);
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.rm(`${globalPath}${suffix}`, { force: true });
  }
  withDatabase(globalPath, (database) => {
    database.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    database.exec("INSERT INTO openclaw_engine_anchor VALUES ('shared', 'postgres', 'shared_ns')");
  });
  const exportDirectories: string[] = [];
  const writeExport = async ({ sourcePath, directory }: ExportParams) => {
    exportDirectories.push(directory);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.copyFile(sourcePath, path.join(directory, "anchor.sqlite"));
    await fs.copyFile(exportedImage, path.join(directory, "database.sqlite"));
    await fs.writeFile(path.join(directory, "manifest.json"), "{}\n");
  };
  const resources = await createBackupResourcePlan({
    stateDir: state.stateDir,
    configPaths: [],
    oauthDirs: [],
    workspaceDirs: [],
    excludedWorkspaceDirs: [],
    agentRoots: [],
    pluginResources: [],
    pluginRoots: [],
  });
  const tempDir = state.path("capture");
  await fs.mkdir(tempDir);
  const capture = () =>
    createBackupSqliteSnapshotPlan({ resources, tempDir, legacyAuditSnapshots: [] });
  return {
    globalPath,
    mainAgentPath: await fs.realpath(mainAgentPath),
    tempDir,
    exportDirectories,
    writeExport,
    capture,
  };
}

async function addAgentStore(state: OpenClawTestState, agentId: string, pathname: string) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  openOpenClawAgentDatabase({ agentId, path: pathname, env: state.env });
  registerOpenClawAgentDatabase({ agentId, path: pathname, env: state.env });
}

// The archived shared image is the export that supplied the registry, and it names only
// stores this capture archived.
async function expectArchivedRegistry(
  result: Awaited<ReturnType<typeof createBackupSqliteSnapshotPlan>>,
  fixture: Awaited<ReturnType<typeof preparePostgresState>>,
) {
  const image = result.snapshots.find(
    ({ archiveSourcePath }) =>
      archiveSourcePath === `${fixture.globalPath}.postgres/database.sqlite`,
  );
  expect(fixture.exportDirectories).toHaveLength(1);
  expect(image?.sourcePath).toBe(path.join(fixture.exportDirectories[0]!, "database.sqlite"));
  const archived = new Set(result.snapshots.map(({ archiveSourcePath }) => archiveSourcePath));
  using database = new DatabaseSync(image!.sourcePath, { readOnly: true });
  const rows = database.prepare("SELECT agent_id, path FROM agent_databases").all() as Array<{
    agent_id: string;
    path: string;
  }>;
  for (const row of rows) {
    const registered = resolveOpenClawRegisteredAgentDatabasePath(fixture.globalPath, row.path);
    expect(archived).toContain(await fs.realpath(registered));
  }
  return rows.map((row) => row.agent_id);
}

async function expectConcurrentDiscarded(
  result: Awaited<ReturnType<typeof createBackupSqliteSnapshotPlan>>,
  tempDir: string,
) {
  for (const snapshot of result.snapshots) {
    expect(snapshot.sourcePath).not.toContain(`${path.sep}concurrent${path.sep}`);
  }
  await expect(fs.stat(path.join(tempDir, "concurrent"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function snapshotStarted(sourcePath: string) {
  const original = sqliteSnapshot.createVerifiedSqliteSnapshot;
  let started!: () => void;
  const promise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spy = vi
    .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
    .mockImplementation((params) => {
      if (params.sourcePath === sourcePath) {
        started();
      }
      return original(params);
    });
  return { promise, spy };
}

function rejectAfter(ms: number, message: string) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

it("captures agent stores while the shared PostgreSQL export runs and keeps manifest order", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-capture-" }, async (state) => {
    const fixture = await preparePostgresState(state);
    const opaqueFile = state.statePath("notes.bin");
    await fs.writeFile(opaqueFile, "not a database");
    const agentCapture = snapshotStarted(fixture.mainAgentPath);
    mocks.exportPostgres.mockImplementation(async (params: ExportParams) => {
      // A serial capture never reaches the agent store before this export finishes.
      await Promise.race([agentCapture.promise, rejectAfter(10_000, "agent capture waited")]);
      await fixture.writeExport(params);
    });

    const result = await fixture.capture();

    expect(result.snapshots.map(({ archiveSourcePath }) => archiveSourcePath)).toEqual([
      `${fixture.globalPath}.postgres/anchor.sqlite`,
      `${fixture.globalPath}.postgres/database.sqlite`,
      `${fixture.globalPath}.postgres/manifest.json`,
      fixture.globalPath,
      fixture.mainAgentPath,
      state.statePath("client", "credentials.sqlite"),
      state.statePath("state", "openclaw-quarantine.sqlite"),
    ]);
    expect(result.postgresSnapshots.map(({ sourcePath }) => sourcePath)).toEqual([
      fixture.globalPath,
    ]);
    await expectArchivedRegistry(result, fixture);
    // The registry adds no store, so the snapshots taken alongside the export are kept.
    for (const snapshot of result.snapshots.slice(4)) {
      expect(snapshot.sourcePath).toContain(`${path.sep}concurrent${path.sep}`);
    }
    // The archive walk classifies files with the returned inventory; discovery already probed them.
    const probes = vi.spyOn(sqliteHeaderProbe, "probeSqliteDatabaseHeaders");
    expect(classifyBackupSqliteSource(opaqueFile, result.inventory)).toBeUndefined();
    expect(probes).not.toHaveBeenCalled();
  });
});

it("recaptures from the exported registry when it adds an agent store", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-registry-" }, async (state) => {
    const extraAgentPath = state.statePath("registered", "extra.sqlite");
    const fixture = await preparePostgresState(state, () =>
      addAgentStore(state, "extra", extraAgentPath),
    );
    mocks.exportPostgres.mockImplementation(fixture.writeExport);

    const result = await fixture.capture();

    const archived = result.snapshots.map(({ archiveSourcePath }) => archiveSourcePath);
    expect(archived).toContain(await fs.realpath(extraAgentPath));
    expect(archived.filter((entry) => entry === fixture.mainAgentPath)).toHaveLength(1);
    expect(result.inventory.resolveSqliteSource(extraAgentPath)).toMatchObject({
      role: "agent",
      agentId: "extra",
    });
    await expectConcurrentDiscarded(result, fixture.tempDir);
    expect(await expectArchivedRegistry(result, fixture)).toContain("extra");
  });
});

it("recaptures when the exported registry moves a known agent to another path", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-moved-" }, async (state) => {
    const movedPath = state.statePath("registered", "main-moved.sqlite");
    const fixture = await preparePostgresState(state, () =>
      addAgentStore(state, "main", movedPath),
    );
    mocks.exportPostgres.mockImplementation(fixture.writeExport);

    const result = await fixture.capture();

    const archived = result.snapshots.map(({ archiveSourcePath }) => archiveSourcePath);
    expect(archived).toContain(await fs.realpath(movedPath));
    expect(archived).toContain(fixture.mainAgentPath);
    await expectConcurrentDiscarded(result, fixture.tempDir);
    await expectArchivedRegistry(result, fixture);
  });
});

it("refuses an exported registry that gives a planned store to another agent", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-reowned-" }, async (state) => {
    const fixture = await preparePostgresState(state, (mainAgentPath) => {
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("INSERT INTO agent_databases VALUES ('other', ?, ?, ?, ?)")
        .run(mainAgentPath, OPENCLAW_AGENT_SCHEMA_VERSION, Date.now(), 1);
    });
    mocks.exportPostgres.mockImplementation(fixture.writeExport);

    // The serial capture refused this registry when it sealed ownership; so does the reuse check.
    await expect(fixture.capture()).rejects.toThrow("aliases multiple core database owners");
  });
});

it("keeps the concurrent snapshots when the exported registry names fewer agents", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-fewer-" }, async (state) => {
    const researchPath = path.join(state.agentDir("research"), "openclaw-agent.sqlite");
    const fixture = await preparePostgresState(state, async () => {
      await addAgentStore(state, "research", researchPath);
      unregisterOpenClawAgentDatabase({ agentId: "research", path: researchPath, env: state.env });
    });
    mocks.exportPostgres.mockImplementation(fixture.writeExport);

    const result = await fixture.capture();

    expect(result.snapshots.map(({ archiveSourcePath }) => archiveSourcePath)).toContain(
      await fs.realpath(researchPath),
    );
    for (const snapshot of result.snapshots.slice(4)) {
      expect(snapshot.sourcePath).toContain(`${path.sep}concurrent${path.sep}`);
    }
    expect(await expectArchivedRegistry(result, fixture)).not.toContain("research");
  });
});

it("aborts the PostgreSQL export when an agent store fails and waits for it", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-sqlite-failure-" }, async (state) => {
    const fixture = await preparePostgresState(state);
    await fs.writeFile(fixture.mainAgentPath, "not a database");
    let exportSettled = false;
    mocks.exportPostgres.mockImplementation(
      (_params: ExportParams, options: ExportOptions) =>
        new Promise((_, reject) => {
          // A worker settles some time after abort; capture must wait for it.
          options?.signal?.addEventListener("abort", () => {
            setTimeout(() => {
              exportSettled = true;
              reject(new Error("export aborted"));
            }, 100);
          });
        }),
    );

    await expect(fixture.capture()).rejects.toThrow(fixture.mainAgentPath);
    expect(exportSettled).toBe(true);
  });
});

it("stops agent captures when the PostgreSQL export fails", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-export-failure-" }, async (state) => {
    const fixture = await preparePostgresState(state);
    const agentCapture = snapshotStarted(fixture.mainAgentPath);
    mocks.exportPostgres.mockRejectedValue(new Error("synthetic export failure"));

    await expect(fixture.capture()).rejects.toThrow("synthetic export failure");
    expect(
      agentCapture.spy.mock.calls.some(([params]) => params.sourcePath === fixture.mainAgentPath),
    ).toBe(false);
  });
});

it("runs another PostgreSQL store export only after the shared export settles", async () => {
  await withBackupFixture({ prefix: "backup-concurrent-postgres-stores-" }, async (state) => {
    const fixture = await preparePostgresState(state);
    // The agent store is a second PostgreSQL anchor; its export takes the same state owner.
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(`${fixture.mainAgentPath}${suffix}`, { force: true });
    }
    withDatabase(fixture.mainAgentPath, (database) => {
      database.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
      );
      database.exec("INSERT INTO openclaw_engine_anchor VALUES ('agent', 'postgres', 'agent_ns')");
    });
    let running = 0;
    const overlaps: string[] = [];
    mocks.exportPostgres.mockImplementation(async (params: ExportParams) => {
      if (running > 0) {
        overlaps.push(params.sourcePath);
      }
      running += 1;
      try {
        await delay(50);
        await fixture.writeExport(params);
      } finally {
        running -= 1;
      }
    });

    const result = await fixture.capture();

    expect(overlaps).toEqual([]);
    expect(result.postgresSnapshots.map(({ sourcePath }) => sourcePath)).toEqual([
      fixture.globalPath,
      fixture.mainAgentPath,
    ]);
  });
});
