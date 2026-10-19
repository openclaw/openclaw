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
  RECOVERY_TRANSCRIPT_LINES,
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

it.each([
  { subject: "transcript", change: "replacement", phase: "preview" },
  ...["new-manifest", "replacement", "symlink", "hardlink"].map((change) => ({
    subject: "destination",
    change,
    phase: "confirmation",
  })),
  ...["replacement", "symlink", "hardlink", "same-size edit"].map((change) => ({
    subject: "transcript",
    change,
    phase: "confirmation",
  })),
])(
  "preserves dependencies after $subject $change at $phase",
  async ({ subject, change, phase }) => {
    const { store, manifestPath, archivePath, target } = await createVerifiedRecoveryStore();
    const file = subject === "transcript" ? archivePath : target.sqlitePath;
    const saved = path.join(store.tempDir, "parked-original");
    const replacement = path.join(store.tempDir, "replacement");
    if (subject === "transcript") {
      fs.writeFileSync(replacement, "unrelated bytes");
    }
    const bytes = Buffer.alloc(fs.statSync(archivePath).size, "x");
    const retained = snapshotFiles(
      [manifestPath, ...target.completedMoves.map((move) => move.archivePath)].filter(
        (entry) => subject !== "transcript" || entry !== archivePath,
      ),
    );
    const mutate = async () => {
      if (change === "new-manifest") {
        const manifest = readMigrationManifest(manifestPath);
        const added = createSessionSqliteMigrationRun(store.env, []);
        added.manifest.targets = manifest.targets;
        added.manifest.completedAt = manifest.completedAt;
        writeSessionSqliteMigrationManifest(added);
      } else if (change === "same-size edit") {
        const contents = fs.readFileSync(file);
        contents[0] = 0x78;
        fs.writeFileSync(file, contents);
      } else {
        const source =
          subject === "destination" ? saved : change === "replacement" ? bytes : replacement;
        changeFile(file, saved, change, source);
      }
      return true;
    };
    if (phase === "preview") {
      await mutate();
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((artifact) => artifact.path === archivePath)).toMatchObject({
        outcome: "blocked",
        reason: "artifact-metadata-changed",
      });
      expect(await retire(store, async () => true, preview)).toMatchObject({
        status: "blocked",
        totals: { removedBytes: 0 },
      });
    } else {
      const reason =
        change === "new-manifest"
          ? /selection changed/i
          : subject === "destination"
            ? /destination|symbolic|hard.link/i
            : /selection changed|artifact/i;
      await expect(retire(store, mutate)).rejects.toThrow(reason);
    }
    expect(fs.existsSync(archivePath)).toBe(true);
    if (subject === "transcript" && change === "replacement") {
      expectFiles(bytes, archivePath);
    }
    if (subject === "transcript") {
      expectFiles("unrelated bytes", replacement);
    }
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
  ...["intent-sync", "publication", "unlink-intent"].map((phase) => ({
    change: "later transcript",
    phase,
  })),
])("retains connected originals after $change during $phase", async ({ change, phase }) => {
  const store = createLegacyStore({
    transcriptLines:
      change === "later transcript"
        ? ['{"type":"session","id":"session-1","version":3}']
        : RECOVERY_TRANSCRIPT_LINES,
  });
  const sibling = path.join(store.sessionDir, "second.jsonl");
  if (change === "later transcript") {
    fs.writeFileSync(sibling, '{"type":"session","id":"second","version":3}\n');
    const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
    index["agent:main:second"] = {
      sessionId: "second",
      updatedAt: 2000,
      sessionFile: "second.jsonl",
    };
    fs.writeFileSync(store.storePath, JSON.stringify(index));
  }
  const imported = await importLegacyStore(store);
  expect(imported.targets[0]?.issues).toEqual([]);
  closeOpenClawAgentDatabasesForTest();
  const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
  const target = readMigrationManifest(manifestPath).targets[0]!;
  const originals = new Map(
    target.completedMoves.map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
  );
  const changed =
    change === "later transcript"
      ? expectDefined(
          target.completedMoves.find((move) => move.sourcePath === sibling),
          "later transcript",
        )
      : target.completedMoves[0]!;
  const databasePath = target.sqlitePath;
  let writer: DatabaseSync | undefined;
  let injected = false;
  const mutate = (moves: SessionSqliteMigrationMove[] = []) => {
    injected = true;
    if (change === "later transcript") {
      const move = expectDefined(
        moves.find((item) => item.archivePath === changed.archivePath),
        "changed transcript receipt",
      );
      const file = recoveryPath(move);
      fs.appendFileSync(file, "unique late history\n");
      originals.set(move.archivePath, fs.readFileSync(file));
      return;
    }
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
        ? directory === path.dirname(changed.archivePath)
        : directory === path.dirname(manifestPath) && atUnlink === (phase === "unlink-intent");
    if (matches) {
      mutate(moves);
    }
  });
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
    if (change !== "later transcript") {
      expectRetained(manifestPath, originals);
    }
  } finally {
    restore();
    writer?.close();
  }
  if (change === "later transcript") {
    expect((await retire(store)).totals.removedFiles).toBe(0);
    expectRetained(manifestPath, originals);
  }
});

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
