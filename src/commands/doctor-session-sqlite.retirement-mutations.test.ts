import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as directoryDurability from "../infra/directory-durability.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import {
  expectFiles,
  expectMissing,
  snapshotFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  isDirectoryDescriptor,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  useDoctorSessionSqliteTestFixture,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

function recoveryPath(move: SessionSqliteMigrationMove) {
  const disposal = move.artifact!.disposal;
  return fs.existsSync(move.archivePath) || disposal.state !== "pending-disposal"
    ? move.archivePath
    : disposal.claimPath;
}

function expectRetained(manifestPath: string, originals: Map<string, Buffer>) {
  for (const move of readMigrationManifest(manifestPath).targets[0]!.completedMoves) {
    expect(move.artifact!.disposal.state).not.toBe("disposed");
    expectFiles(originals.get(move.archivePath), recoveryPath(move));
  }
}

function changeFile(
  file: string,
  saved: string,
  kind: string,
  replacement: string | Buffer = saved,
) {
  if (kind === "hardlink") {
    fs.linkSync(file, saved);
  } else {
    fs.renameSync(file, saved);
    if (kind === "symlink" && typeof replacement === "string") {
      fs.symlinkSync(replacement, file);
    } else if (typeof replacement !== "string") {
      fs.writeFileSync(file, replacement);
    } else {
      fs.copyFileSync(replacement, file);
    }
  }
}

function observePhase(
  manifestPath: string,
  archivePath: string,
  phase: string,
  mutate: (moves: SessionSqliteMigrationMove[]) => void,
) {
  let injected = false;
  const restore = observeRecoveryDirectorySync(path.dirname(manifestPath), (directory) => {
    if (injected || phase === "confirmation") {
      return;
    }
    const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
    const atUnlink = moves.some(
      (move) =>
        move.artifact?.disposal.state === "pending-disposal" &&
        move.artifact.disposal.phase === "unlink-pending",
    );
    const matches =
      phase === "publication"
        ? directory === path.dirname(archivePath)
        : directory === path.dirname(manifestPath) && atUnlink === (phase === "unlink-intent");
    if (matches) {
      injected = true;
      mutate(moves);
    }
  });
  return { restore, injected: () => injected };
}

function retire(
  store: TestStore,
  confirm: Parameters<typeof retireSessionSqliteRecovery>[0]["confirm"] = async () => true,
  preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
) {
  return retireSessionSqliteRecovery({
    env: store.env,
    preview,
    readConfig: async () => ({}),
    confirm,
  });
}

it.each([false, true])(
  "checks shared manifests once and preserves confirmation changes: %s",
  async (changed) => {
    const { store, manifestPath, manifest, archivePath } = await createVerifiedRecoveryStore();
    const duplicate = createSessionSqliteMigrationRun(store.env, []);
    duplicate.manifest.targets = structuredClone(manifest.targets);
    duplicate.manifest.completedAt = manifest.completedAt;
    writeSessionSqliteMigrationManifest(duplicate);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    const original = fs.readFileSync(archivePath);
    const reads = vi.spyOn(fs, "readFileSync");
    try {
      const cleanup = retire(
        store,
        async () => {
          if (changed) {
            duplicate.manifest.startedAt = "2026-01-01T00:00:00.000Z";
            writeSessionSqliteMigrationManifest(duplicate);
          }
          reads.mockClear();
          return true;
        },
        preview,
      );
      if (changed) {
        await expect(cleanup).rejects.toThrow("Recovery manifest changed during confirmation");
        expectFiles(original, archivePath);
      } else {
        const result = await cleanup;
        expect(result).toMatchObject({ status: "complete", totals: { removedFiles: 2 } });
        expectMissing(archivePath);
        expect(result.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
        // The post-confirmation inventory supplies each manifest's only read.
        for (const file of [manifestPath, duplicate.manifestPath]) {
          expect(reads.mock.calls.filter(([input]) => input === file)).toHaveLength(1);
        }
      }
    } finally {
      reads.mockRestore();
    }
  },
);

it("blocks a same-size replacement recovery original during preview", async () => {
  const { store, archivePath } = await createVerifiedRecoveryStore();
  const original = fs.readFileSync(archivePath);
  fs.renameSync(archivePath, path.join(store.tempDir, "parked-original"));
  const replacement = Buffer.alloc(original.length, "x");
  fs.writeFileSync(archivePath, replacement);

  const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
  expect(preview.artifacts.find((artifact) => artifact.path === archivePath)).toMatchObject({
    outcome: "blocked",
    reason: "artifact-metadata-changed",
  });
  const result = await retire(store, async () => true, preview);
  expect(result).toMatchObject({ status: "blocked", totals: { removedBytes: 0 } });
  expectFiles(replacement, archivePath);
});

it.each(["new-manifest", "replacement", "symlink", "hardlink"])(
  "refuses a recovery ownership change during confirmation: %s",
  async (kind) => {
    const { store, manifestPath, target, archivePath } = await createVerifiedRecoveryStore();
    const databasePath = target.sqlitePath;
    const saved = path.join(store.tempDir, "saved-destination.sqlite");
    const original = fs.readFileSync(archivePath);
    await expect(
      retire(store, async () => {
        if (kind === "new-manifest") {
          const manifest = readMigrationManifest(manifestPath);
          const added = createSessionSqliteMigrationRun(store.env, []);
          added.manifest.targets = manifest.targets;
          added.manifest.completedAt = manifest.completedAt;
          writeSessionSqliteMigrationManifest(added);
        } else {
          changeFile(databasePath, saved, kind);
        }
        return true;
      }),
    ).rejects.toThrow(
      kind === "new-manifest" ? /selection changed/i : /destination|symbolic|hard.link/i,
    );
    expectFiles(original, archivePath);
  },
);

it.each(["replacement", "symlink", "hardlink", "same-size edit"])(
  "preserves every recovery dependency after a transcript %s during confirmation",
  async (change) => {
    const { store, manifestPath, archivePath, target } = await createVerifiedRecoveryStore();
    const retained = snapshotFiles(
      target.completedMoves.map((move) => move.archivePath).filter((file) => file !== archivePath),
    );
    const manifestBefore = fs.readFileSync(manifestPath);
    const original = fs.readFileSync(archivePath);
    const replacement = path.join(store.tempDir, "replacement");
    fs.writeFileSync(replacement, "unrelated bytes");
    await expect(
      retire(store, async () => {
        if (change === "same-size edit") {
          const contents = fs.readFileSync(archivePath);
          contents[0] = 0x78;
          fs.writeFileSync(archivePath, contents);
        } else {
          const source =
            change === "replacement" ? Buffer.alloc(original.length, "x") : replacement;
          changeFile(archivePath, path.join(store.tempDir, "parked-original"), change, source);
        }
        return true;
      }),
    ).rejects.toThrow(/selection changed|artifact/i);
    expect(fs.existsSync(archivePath)).toBe(true);
    if (change === "replacement") {
      expectFiles(Buffer.alloc(original.length, "x"), archivePath);
    }
    expectFiles("unrelated bytes", replacement);
    expectFiles(manifestBefore, manifestPath);
    for (const artifact of retained) {
      expectFiles(artifact.bytes, artifact.file);
    }
  },
);

it.each([
  { change: "in-place edit", phase: "confirmation" },
  ...["confirmation", "publication", "unlink-intent"].map((phase) => ({
    change: "WAL commit",
    phase,
  })),
])("retains originals after destination $change during $phase", async ({ change, phase }) => {
  const { store, manifestPath, target } = await createVerifiedRecoveryStore();
  const originals = new Map(
    target.completedMoves.map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
  );
  const databasePath = target.sqlitePath;
  let writer: DatabaseSync | undefined;
  let injected = false;
  const mutate = () => {
    injected = true;
    const before = fs.statSync(databasePath, { bigint: true });
    if (change === "WAL commit") {
      const databaseBefore = fs.readFileSync(databasePath);
      writer = nodeSqlite.openNodeSqliteDatabase(databasePath);
      writer.exec("DELETE FROM transcript_events");
      expectFiles(databaseBefore, databasePath);
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(32);
    } else {
      const bytes = fs.readFileSync(databasePath);
      bytes[0] = 0;
      fs.writeFileSync(databasePath, bytes);
      fs.utimesSync(databasePath, before.atime, before.mtime);
      expect(fs.statSync(databasePath).size).toBe(bytes.length);
    }
    expect(fs.statSync(databasePath, { bigint: true }).ino).toBe(before.ino);
  };
  const observer = observePhase(manifestPath, target.completedMoves[0]!.archivePath, phase, mutate);
  try {
    const cleanup = retire(store, async () => {
      if (phase === "confirmation") {
        mutate();
      }
      return true;
    });
    if (phase === "confirmation") {
      await expect(cleanup).rejects.toThrow(/destination/i);
    } else {
      expect(await cleanup).toMatchObject({ status: "blocked", totals: { removedFiles: 0 } });
    }
    expect(injected).toBe(true);
    expectRetained(manifestPath, originals);
  } finally {
    observer.restore();
    writer?.close();
  }
});

it.each(["intent-sync", "publication", "unlink-intent"])(
  "preserves connected originals when a later transcript changes during %s",
  async (phase) => {
    const store = createLegacyStore({
      transcriptLines: [JSON.stringify({ type: "session", id: "session-1", version: 3 })],
    });
    const sibling = path.join(store.sessionDir, "second.jsonl");
    fs.writeFileSync(sibling, '{"type":"session","id":"second","version":3}\n');
    const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
    index["agent:main:second"] = {
      sessionId: "second",
      updatedAt: 2000,
      sessionFile: "second.jsonl",
    };
    fs.writeFileSync(store.storePath, JSON.stringify(index));
    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    closeOpenClawAgentDatabasesForTest();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const target = readMigrationManifest(manifestPath).targets[0]!;
    const originals = new Map(
      target.completedMoves.map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
    );
    const changed = expectDefined(
      target.completedMoves.find((move) => move.sourcePath === sibling),
      "later transcript",
    );
    const observer = observePhase(manifestPath, changed.archivePath, phase, (moves) => {
      const move = expectDefined(
        moves.find((mappedMove) => mappedMove.archivePath === changed.archivePath),
        "changed transcript receipt",
      );
      const file = recoveryPath(move);
      fs.appendFileSync(file, "unique late history\n");
      originals.set(move.archivePath, fs.readFileSync(file));
    });
    const invoke = () => retire(store);
    try {
      expect(await invoke()).toMatchObject({ status: "blocked", totals: { removedFiles: 0 } });
      expect(observer.injected()).toBe(true);
    } finally {
      observer.restore();
    }
    expect((await invoke()).totals.removedFiles).toBe(0);
    expectRetained(manifestPath, originals);
  },
);

function observeRecoveryDirectorySync(
  manifestDir: string,
  onSynced: (directory: string) => void,
): () => void {
  const sync = directoryDurability.syncDirectory;
  const asyncSpy = vi
    .spyOn(directoryDurability, "syncDirectory")
    .mockImplementation(async (directory, options) => {
      const result = await sync(directory, options);
      onSynced(typeof directory === "string" ? directory : directory.path);
      return result;
    });
  const fsync = fs.fsyncSync;
  const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    fsync(fd);
    if (isDirectoryDescriptor(fd, manifestDir)) {
      onSynced(manifestDir);
    }
  });
  return () => {
    asyncSpy.mockRestore();
    syncSpy.mockRestore();
  };
}
