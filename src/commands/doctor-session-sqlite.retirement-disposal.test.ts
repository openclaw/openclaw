import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { readSessionTranscriptHistoryEventPage } from "../config/sessions/session-accessor.sqlite-history-events.js";
import {
  readSessionTranscriptHistoryEvents as historyEvents,
  readSessionTranscriptHistoryEventCount as historyCount,
  readSessionTranscriptHistoryEventById as historyById,
} from "../config/sessions/session-accessor.sqlite-history.test-support.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import * as sqlitePrivateDirectory from "../infra/sqlite-private-directory.js";
import * as windowsPrivateDirectory from "../infra/windows-private-directory.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  isDirectoryDescriptor,
  importLegacyStore,
  readMigrationManifest as readManifest,
  requireMigrationManifestPath,
  type TestStore,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

function retire(
  store: TestStore,
  confirm = async () => true,
  preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
) {
  return retireSessionSqliteRecovery({
    env: store.env,
    preview,
    readConfig: async () => ({}),
    confirm,
  });
}

function message(id: string, content: unknown, parentId: string | null = null, role = "user") {
  return { type: "message", id, parentId, message: { role, content } };
}

function transcriptStore(...events: unknown[]) {
  return createLegacyStore({
    transcriptLines: [{ type: "session", id: "session-1", version: 3 }, ...events].map((event) =>
      JSON.stringify(event),
    ),
  });
}

function hasCountMismatch(report: Awaited<ReturnType<typeof importLegacyStore>>) {
  return report.targets[0]?.issues.some(
    (issue) => issue.code === "sqlite_transcript_count_mismatch",
  );
}

function transcriptMove(manifestPath: string | undefined) {
  return readManifest(manifestPath).targets[0]?.completedMoves.find(
    (move) => move.kind === "transcript",
  );
}

function disposalState(file: string, archive: string, planned = false) {
  const target = readManifest(file).targets[0];
  return (planned ? target?.plannedMoves : target?.completedMoves)?.find(
    (move) => move.archivePath === archive,
  )?.artifact?.disposal.state;
}

function sessionScope(store: TestStore) {
  return { agentId: "main", storePath: store.storePath, sessionId: "session-1" };
}

it.each([
  "intent",
  "intent-sync",
  "claim",
  "unlink",
  "unlink-later",
  "recreated",
  "shared-receipt",
])("resumes %s disposal without overclaiming bytes", async (phase) => {
  const { store, imported, archivePath } = await createVerifiedRecoveryStore();
  const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const duplicate =
    phase === "shared-receipt" ? createSessionSqliteMigrationRun(store.env, []) : undefined;
  if (duplicate) {
    const manifest = readManifest(manifestPath);
    duplicate.manifest.targets = structuredClone(manifest.targets);
    duplicate.manifest.completedAt = manifest.completedAt;
    writeSessionSqliteMigrationManifest(duplicate);
  }
  const original = fs.readFileSync(archivePath);
  let injected = false;
  let claimUnlinks = 0;
  const write = replaceFile.replaceFileAtomicSync;
  const unlink = fs.unlinkSync;
  const fsync = fs.fsyncSync;
  {
    using syncSpy = vi.spyOn(fs, "fsyncSync");
    syncSpy.mockImplementation((fd) => {
      if (!injected && phase === "intent-sync" && isDirectoryDescriptor(fd, manifestDir)) {
        injected = true;
        throw new Error("injected intent-sync");
      }
      fsync(fd);
    });
    using writeSpy = vi.spyOn(replaceFile, "replaceFileAtomicSync");
    writeSpy.mockImplementation((options) => {
      const text = String(options.content);
      const shouldFail =
        phase === "intent"
          ? text.includes('"pending-disposal"')
          : duplicate && options.filePath === manifestPath && text.includes('"disposed"');
      if (!injected && shouldFail) {
        injected = true;
        if (duplicate) {
          expect(disposalState(duplicate.manifestPath, archivePath, true)).toBe("disposed");
        }
        throw new Error(`injected ${phase}`);
      }
      return write(options);
    });
    using unlinkSpy = vi.spyOn(fs, "unlinkSync");
    unlinkSpy.mockImplementation((file) => {
      if (String(file).includes(".cleanup-")) {
        claimUnlinks += 1;
      }
      if (
        !injected &&
        (((phase === "unlink" || phase === "recreated") && String(file).includes(".cleanup-")) ||
          (phase === "unlink-later" && claimUnlinks === 2) ||
          (phase === "claim" && String(file) === archivePath))
      ) {
        injected = true;
        throw new Error(`injected ${phase}`);
      }
      return unlink(file);
    });
    if (phase === "intent" || phase === "intent-sync") {
      await expect(retire(store)).rejects.toThrow(`injected ${phase}`);
      expect(fs.readFileSync(archivePath)).toEqual(original);
    } else {
      const first = await retire(store);
      expect(first.status).toBe("blocked");
      if (phase === "unlink-later") {
        expect(first.totals.removedFiles).toBe(1);
      }
      if (duplicate) {
        expect(first.artifacts.find((item) => item.path === archivePath)?.removedBytes).toBe(
          original.length,
        );
      }
    }
  }
  expect(injected).toBe(true);
  if (phase === "recreated") {
    fs.writeFileSync(archivePath, "replacement after interrupted cleanup");
  }
  const resumed = await retire(store);
  if (phase === "recreated") {
    expect(resumed.status).toBe("blocked");
    expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement after interrupted cleanup");
    expect(
      resumed.artifacts.find((item) => item.path === archivePath)?.removedBytes,
    ).toBeUndefined();
    return;
  }
  expect(resumed.status).toBe("complete");
  if (duplicate) {
    for (const file of [manifestPath, duplicate.manifestPath]) {
      expect(disposalState(file, archivePath, true)).toBe("disposed");
    }
  }
  expect(fs.existsSync(archivePath)).toBe(false);
  if (duplicate) {
    expect(resumed.totals.removedBytes).toBe(0);
  }
});

it.each([
  { platform: "win32", syncFailure: "unsupported", retires: true },
  { platform: "linux", syncFailure: "unsupported", retires: false },
  { platform: "win32", syncFailure: "EIO", retires: false },
] as const)(
  "applies directory-sync policy for $platform $syncFailure",
  async ({ platform, syncFailure, retires }) => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const original = fs.readFileSync(archivePath);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    const fsync = fs.fsyncSync;
    const failureCode = syncFailure === "EIO" ? "EIO" : platform === "win32" ? "EPERM" : "ENOTSUP";
    // Simulate directory-sync policy without invoking foreign-platform ACL APIs.
    const stagingRootSpy = vi
      .spyOn(sqlitePrivateDirectory, "resolvePrivateSqliteSnapshotStagingRoot")
      .mockReturnValue(store.tempDir);
    const privateDirectorySpy = vi
      .spyOn(windowsPrivateDirectory, "createPrivateWindowsDirectory")
      .mockImplementation((directoryPath) => {
        fs.mkdirSync(directoryPath, { mode: 0o700 });
      });
    const installPlatformSpy = () => vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    let platformSpy: ReturnType<typeof installPlatformSpy> | undefined;
    const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!isDirectoryDescriptor(fd, path.dirname(manifestPath))) {
        return fsync(fd);
      }
      platformSpy ??= installPlatformSpy();
      // Assert the persisted intent at the commit boundary, before any original moves.
      if (fs.existsSync(archivePath)) {
        expect(disposalState(manifestPath, archivePath)).toBe("pending-disposal");
        expect(fs.readFileSync(archivePath)).toEqual(original);
      }
      throw Object.assign(new Error(`injected manifest ${failureCode}`), { code: failureCode });
    });
    try {
      const cleanup = retire(store, undefined, preview);
      if (retires) {
        const result = await cleanup;
        expect(result.status).toBe("complete");
        expect(result.artifacts.find((item) => item.path === archivePath)).toMatchObject({
          outcome: "removed",
          removedBytes: original.length,
        });
        expect(fs.existsSync(archivePath)).toBe(false);
        expect(disposalState(manifestPath, archivePath)).toBe("disposed");
      } else {
        await expect(cleanup).rejects.toThrow(`injected manifest ${failureCode}`);
        expect(fs.readFileSync(archivePath)).toEqual(original);
      }
    } finally {
      syncSpy.mockRestore();
      platformSpy?.mockRestore();
      privateDirectorySpy.mockRestore();
      stagingRootSpy.mockRestore();
    }
  },
);

it("refuses retirement while a peer maintenance operation holds the selected state", async () => {
  const { store, archivePath } = await createVerifiedRecoveryStore();
  const original = fs.readFileSync(archivePath);
  const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
  const confirm = vi.fn(async () => true);
  await withDoctorSqliteMaintenanceLock({
    env: store.env,
    operation: "fixture import",
    run: async () => {
      await expect(
        runOutsideOpenClawDatabaseMaintenanceScope(() => retire(store, confirm, preview)),
      ).rejects.toThrow("undergoing offline maintenance");
    },
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(fs.readFileSync(archivePath)).toEqual(original);
});

it.each([
  { name: "invalid message", rows: [{ type: "message", id: "bad", message: {} }] },
  { name: "unknown event", rows: [{ type: "future_event", id: "unknown", payload: "unique" }] },
  {
    name: "duplicate divergent ID",
    rows: [message("duplicate", "first"), message("duplicate", "unique second")],
  },
  { name: "missing ancestor", rows: [message("child", "history", "missing")] },
])("protects $name and its recovery index", async ({ rows, name }) => {
  const store = transcriptStore(...rows);
  const original = fs.readFileSync(store.transcriptPath);
  const imported = await importLegacyStore(store);
  const move = transcriptMove(imported.migrationRun?.manifestPath);
  if (name === "duplicate divergent ID") {
    expect(move).toBeUndefined();
    expect(hasCountMismatch(imported)).toBe(true);
  } else {
    expect(move).toBeDefined();
  }
  closeOpenClawAgentDatabasesForTest();
  const result = await retire(store);
  expect(result.totals.removedFiles).toBe(0);
  if (move) {
    expect(result.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
      "protected",
    );
  }
  expect(fs.readFileSync(move?.archivePath ?? store.transcriptPath)).toEqual(original);
});

it("retains complete recovery when durable transcript verification is short", async () => {
  const store = transcriptStore(message("root", "root"));
  const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
  let imported;
  {
    using spy = vi.spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot");
    spy.mockImplementation((target) => {
      const result = snapshot(target);
      if (!result.ok) {
        return result;
      }
      const counts = new Map(result.snapshot.transcriptEventCountsBySessionId);
      counts.set("session-1", 1);
      return {
        ok: true,
        snapshot: { ...result.snapshot, transcriptEventCountsBySessionId: counts },
      };
    });
    imported = await importLegacyStore(store);
  }

  expect(hasCountMismatch(imported)).toBe(true);
  expect(fs.existsSync(store.transcriptPath)).toBe(true);
  expect(transcriptMove(imported.migrationRun?.manifestPath)).toBeUndefined();
});

it.each(["fresh", "identical", "divergent"] as const)(
  "verifies duplicate replays against %s destinations",
  async (kind) => {
    const fresh = kind === "fresh";
    const archived = kind !== "divergent";
    const first = message(
      "reply",
      fresh ? "same replay" : [{ type: "text", text: "same replay" }],
      "root",
      "assistant",
    );
    const leaf = { type: "leaf", id: "selection", parentId: "reply", targetId: "reply" };
    const sourceEvents = [
      fresh
        ? { type: "session", id: "session-1", version: 3 }
        : { type: "session", id: "session-1", version: 3, timestamp: "", cwd: "" },
      message("root", "root"),
      first,
      archived
        ? first
        : {
            ...first,
            message: { role: "assistant", content: [{ type: "text", text: "different replay" }] },
          },
      ...(fresh ? [leaf, leaf] : []),
    ];
    const store = createLegacyStore({
      transcriptLines: sourceEvents.map((event) => JSON.stringify(event)),
    });
    const original = fs.readFileSync(store.transcriptPath);
    const scope = { agentId: "main", env: store.env, sessionId: "session-1" };
    if (!fresh) {
      await importSqliteSessionRows({
        ...scope,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
        entry: { sessionId: "session-1", updatedAt: 1000 },
        readTranscriptEvents: (append) => sourceEvents.slice(0, 3).forEach(append),
      });
    }
    const existingEvents = fresh ? undefined : loadTranscriptEventsSync(scope);
    const run = () => importLegacyStore(store);
    const imported = await run();
    expect(fs.existsSync(store.transcriptPath)).toBe(!archived);
    expect(Boolean(transcriptMove(imported.migrationRun?.manifestPath))).toBe(archived);
    expect(hasCountMismatch(imported)).toBe(!archived);
    expect(loadTranscriptEventsSync(scope).map((event) => (event as { id?: string }).id)).toEqual([
      "session-1",
      "root",
      "reply",
      ...(fresh ? ["selection"] : []),
    ]);
    if (existingEvents) {
      expect(loadTranscriptEventsSync(scope)).toEqual(existingEvents);
    }
    if (fresh) {
      expect(imported.targets[0]?.issues).toEqual([]);
      expect(historyEvents(scope).map((row) => (row.event as { id?: string }).id)).toEqual([
        "root",
        "reply",
      ]);
      expect(historyCount(scope)).toBe(2);
      expect(
        readSessionTranscriptHistoryEventPage(scope, { maxMessages: 1, offset: 0 }),
      ).toMatchObject({
        activeLeafEntryId: "reply",
        totalMessages: 2,
        events: [expect.objectContaining({ event: expect.objectContaining({ id: "reply" }) })],
      });
      expect(historyById(scope, "reply")).toMatchObject({
        event: expect.objectContaining({ id: "reply" }),
      });
    } else if (!archived) {
      const retried = await run();
      expect(hasCountMismatch(retried)).toBe(true);
      expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      expect(loadTranscriptEventsSync(scope)).toEqual(existingEvents);
    }
  },
);

it("retires verified originals after remount while preserving current SQLite and unknown archives", async () => {
  const store = transcriptStore(
    message(
      "original-only",
      "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ),
    message("user-1", "hello"),
    {
      ...message("reply-1", "hello back", "user-1", "assistant"),
      message: { role: "assistant", provider: "openai-codex", content: "hello back" },
    },
  );
  const original = fs.readFileSync(store.transcriptPath);
  const imported = await importLegacyStore(store);
  expect(imported.targets[0]?.issues).toEqual([]);
  const manifest = readManifest(imported.migrationRun?.manifestPath);
  for (const target of manifest.targets) {
    for (const move of [...target.plannedMoves, ...target.completedMoves]) {
      if (move.artifact) {
        move.artifact.identity.dev = String(BigInt(move.artifact.identity.dev) + 1n);
      }
    }
  }
  writeSessionSqliteMigrationManifest({
    manifest,
    manifestPath: imported.migrationRun!.manifestPath,
  });
  const originalMove = manifest.targets[0]!.completedMoves.find(
    (move) => move.kind === "transcript",
  )!;
  expect(fs.readFileSync(originalMove.archivePath)).toEqual(original);
  expect(originalMove.artifact?.classification).toBe("repair-original");
  expect(loadTranscriptEventsSync(sessionScope(store))).toEqual(
    ["session-1", "user-1", "reply-1"].map((id) => expect.objectContaining({ id })),
  );
  const manager = SessionManager.open(
    {
      ...sessionScope(store),
      sessionKey: "agent:main:main",
    },
    store.tempDir,
  );
  manager.appendMessage({
    role: "user",
    content: "history written after the upgrade",
    timestamp: Date.now(),
  });
  closeOpenClawAgentDatabasesForTest();
  const sqlitePath = imported.targets[0]!.sqlitePath;
  const databaseBefore = fs.readFileSync(sqlitePath);
  expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
  expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(false);
  // Keep real source sidecars present independently of cached owner inspection.
  using sourceReader = new DatabaseSync(sqlitePath, { readOnly: true });
  sourceReader.prepare("SELECT count(*) FROM sqlite_schema").get();
  const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
  expect(preview.artifacts.find((item) => item.path === originalMove.archivePath)?.outcome).toBe(
    "candidate",
  );
  const cleanup = await retire(
    store,
    async () => {
      expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(true);
      return true;
    },
    preview,
  );
  expect(cleanup.status).toBe("complete");
  expect(cleanup.totals.removedFiles).toBe(2);
  expect(cleanup.totals.removedBytes).toBeGreaterThan(original.length);
  expect(fs.existsSync(originalMove.archivePath)).toBe(false);
  expect(fs.readFileSync(sqlitePath)).toEqual(databaseBefore);
  expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
  const retry = await retire(store);
  expect(retry.totals.removedBytes).toBe(0);
  const restored = await runDoctorSessionSqlite({
    allAgents: true,
    cfg: {},
    env: store.env,
    mode: "restore",
  });
  expect(
    restored.targets[0]?.restore?.conflicts.some((item) =>
      item.reason.includes("intentionally disposed"),
    ),
  ).toBe(true);
});
