import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, aroundEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ActiveSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { ExitError } from "../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import { doctorCommand } from "./doctor.js";

export type SessionSqliteMigrationManifest = ActiveSessionSqliteMigrationRun["manifest"];

export function stateRows(env: NodeJS.ProcessEnv, query: string) {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => db.prepare(query).all(), { env });
}

export function writeState(env: NodeJS.ProcessEnv, ...statements: [string, ...SQLInputValue[]][]) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      for (const [query, ...values] of statements) {
        db.prepare(query).run(...values);
      }
    },
    { env },
  );
}

export function expectNoIssue(report: DoctorSessionSqliteReport, code: string) {
  expect(report.targets.flatMap((target) => target.issues)).not.toContainEqual(
    expect.objectContaining({ code }),
  );
}

export type TestStore = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  sessionDir: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
  unreferencedJsonlPath: string;
  trajectoryPath: string;
  transcriptPath: string;
};

export const RECOVERY_TRANSCRIPT_LINES = Object.freeze([
  '{"type":"session","id":"session-1","version":3,"timestamp":"2026-08-30T00:00:00Z","cwd":"/fixture"}',
  '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"preserved history"}}',
]);

const legacyEntry = {
  channel: "cli",
  chatType: "direct",
  sessionFile: "session-1.jsonl",
  sessionId: "session-1",
  sessionStartedAt: 1000,
  updatedAt: 2000,
};

export async function runPublicSessionSqlite(
  store: TestStore,
  mode: "import" | "restore" | "recover",
) {
  let exitCode: number | undefined;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      exitCode = code;
      throw new ExitError(code);
    }),
  };
  try {
    await doctorCommand(runtime, {
      sessionSqlite: mode,
      sessionSqliteStore: store.storePath,
      json: true,
    });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
  }
  const output = expectDefined(runtime.log.mock.calls.at(-1)?.[0], "Doctor JSON report");
  return {
    exitCode: expectDefined(exitCode, "Doctor exit code"),
    report: JSON.parse(String(output)) as DoctorSessionSqliteReport,
  };
}

export function isDirectoryDescriptor(fd: number, directory: string): boolean {
  const opened = fs.fstatSync(fd);
  if (!opened.isDirectory()) {
    return false;
  }
  const expected = fs.statSync(directory);
  return opened.dev === expected.dev && opened.ino === expected.ino;
}

export function importLegacyStore(store: TestStore): Promise<DoctorSessionSqliteReport> {
  return runDoctorSessionSqlite({ env: store.env, mode: "import", store: store.storePath });
}

export function readMigrationManifest(
  manifestPath: string | undefined,
): SessionSqliteMigrationManifest {
  return JSON.parse(
    fs.readFileSync(requireMigrationManifestPath(manifestPath), "utf-8"),
  ) as SessionSqliteMigrationManifest;
}

export function requireMigrationManifestPath(manifestPath: string | undefined): string {
  if (!manifestPath) {
    throw new Error("expected migration manifest path");
  }
  return manifestPath;
}

export function trustedMigrationTarget(store: TestStore) {
  const target = { agentId: "main", storePath: store.storePath };
  return {
    ...target,
    sqlitePath: resolveTargetSqlitePath(target),
  };
}

export function canonicalTestPaths(paths: string[]): string[] {
  return paths.map((filePath) => canonicalTestPath(filePath)).toSorted();
}

export function canonicalTestPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function writePrivate(file: string, contents: string) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

export function useDoctorSessionSqliteTestFixture() {
  const previousEnv = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-doctor-session-sqlite-");
  // Platform-alias cases keep their requested lexical root; drain its canonical owner path.
  const explicitRoots = new Set<string>();
  const explicitTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      if (explicitRoots.size === 0) {
        return;
      }
      for (const root of explicitRoots) {
        await closeOpenClawAgentDatabasesAsync(root);
      }
      await closeStateDatabaseForTest();
      cleanup();
    }),
  );
  const autoCleanupTempDirs = {
    make(prefix: string, tempRoot?: string) {
      if (!tempRoot) {
        return sessionDirs.make();
      }
      const root = explicitTempDirs.make(prefix, tempRoot);
      explicitRoots.add(fs.realpathSync.native(root));
      return root;
    },
  };
  // Reuse child imports within each case; snapshots still admit and read fresh state.
  aroundEach((runTest) => withSqliteReadOnlyWorkerScope(runTest));
  beforeEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    previousEnv.restore();
  });

  function createLegacyStore(
    params: {
      agentDirName?: string;
      customStore?: boolean;
      entryOverrides?: Record<string, unknown>;
      tempRoot?: string;
      transcriptLines?: readonly string[];
    } = {},
  ): TestStore {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-", params.tempRoot);
    const stateDir = path.join(tempDir, "state");
    const configPath = path.join(tempDir, "openclaw.json");
    const sessionDir = params.customStore
      ? path.join(tempDir, "legacy-session-store")
      : path.join(stateDir, "agents", params.agentDirName ?? "main", "sessions");
    const storePath = path.join(sessionDir, "sessions.json");
    const transcriptPath = path.join(sessionDir, "session-1.jsonl");
    const trajectoryPath = path.join(sessionDir, "session-1.trajectory.jsonl");
    const unreferencedJsonlPath = path.join(sessionDir, "orphan.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    writePrivate(configPath, "{}\n");
    const entries = { "agent:main:main": { ...legacyEntry, ...params.entryOverrides } };
    writePrivate(storePath, JSON.stringify(entries, null, 2));
    writePrivate(
      transcriptPath,
      `${(params.transcriptLines ?? ['{"type":"session","sessionId":"session-1"}', '{"type":"event","id":"evt-1"}']).join("\n")}\n`,
    );
    writePrivate(trajectoryPath, '{"type":"trajectory"}\n');
    writePrivate(unreferencedJsonlPath, '{"type":"event"}\n');
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    return {
      configPath,
      env,
      sessionDir,
      stateDir,
      storePath,
      tempDir,
      unreferencedJsonlPath,
      trajectoryPath,
      transcriptPath,
    };
  }

  async function createImportedStoreForCompaction(shared = false): Promise<{
    sqlitePath: string;
    store: TestStore;
  }> {
    const store = createLegacyStore({ agentDirName: shared ? "alpha" : undefined });
    const report = await importLegacyStore(store);
    let sqlitePath = expectDefined(report.targets[0]?.sqlitePath, "imported agent SQLite path");
    closeOpenClawAgentDatabasesForTest();
    if (shared) {
      const sharedPath = path.join(store.stateDir, "shared.sqlite");
      fs.renameSync(sqlitePath, sharedPath);
      sqlitePath = sharedPath;
      store.storePath = sharedPath;
    }
    return { sqlitePath, store };
  }

  function createHistoricalRestoreStore(version: 1 | 2) {
    const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
    const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
    const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    // Model the historical on-disk contract directly; the current importer is not fixture setup.
    const moves = (
      [
        ["transcript", store.transcriptPath],
        ["trajectory", store.trajectoryPath],
        ["unreferenced-jsonl", store.unreferencedJsonlPath],
        ["legacy-store", store.storePath],
      ] as const
    ).map(([kind, sourcePath]) => {
      const archivePath = path.join(archiveDir, `${kind}.${path.basename(sourcePath)}.imported-1`);
      fs.renameSync(sourcePath, archivePath);
      return { kind, sourcePath, archivePath };
    });
    const manifest: SessionSqliteMigrationManifest = {
      manifestVersion: version,
      openClawVersion: "test",
      runId: `historical-v${version}`,
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:01.000Z",
      targets: [
        {
          ...trustedMigrationTarget(store),
          plannedMoves: moves,
          completedMoves: structuredClone(moves),
          issues: [],
          validationBeforeArchive: "passed",
        },
      ],
    };
    const manifestPath = path.join(runsDir, `${manifest.runId}.json`);
    writePrivate(manifestPath, `${JSON.stringify(manifest)}\n`);
    const archivePath = expectDefined(
      moves.find((move) => move.kind === "transcript"),
      "historical transcript archive",
    ).archivePath;
    return { store, manifestPath, manifest, archivePath };
  }

  async function createVerifiedRecoveryStore(
    transcriptLines: readonly string[] = RECOVERY_TRANSCRIPT_LINES,
  ) {
    const store = createLegacyStore({ transcriptLines });
    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = manifest.targets[0]!;
    const archivePath = target.completedMoves.find(
      (move) => move.kind === "transcript",
    )!.archivePath;
    closeOpenClawAgentDatabasesForTest();
    return { store, imported, archivePath, manifestPath, manifest, target };
  }

  return {
    autoCleanupTempDirs,
    createLegacyStore,
    createImportedStoreForCompaction,
    createHistoricalRestoreStore,
    createVerifiedRecoveryStore,
  };
}
