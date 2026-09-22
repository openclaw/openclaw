import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as directoryDurability from "../infra/directory-durability.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import {
  isDirectoryDescriptor,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("refuses new recovery references introduced during confirmation", async () => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifest = readMigrationManifest(
      requireMigrationManifestPath(imported.migrationRun?.manifestPath),
    );
    const original = fs.readFileSync(archivePath);
    await expect(
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => {
          const added = createSessionSqliteMigrationRun(store.env, []);
          added.manifest.targets = manifest.targets;
          added.manifest.completedAt = manifest.completedAt;
          writeSessionSqliteMigrationManifest(added);
          return true;
        },
      }),
    ).rejects.toThrow(/selection changed/i);
    expect(fs.readFileSync(archivePath)).toEqual(original);
  });

  it.each([false, true])(
    "blocks a replaced recovery original during preview (same size: %s)",
    async (sameSize) => {
      const { store, archivePath } = await createVerifiedRecoveryStore();
      const original = fs.readFileSync(archivePath);
      fs.renameSync(archivePath, path.join(store.tempDir, "parked-original"));
      const replacement = Buffer.alloc(sameSize ? original.length : 7, "x");
      fs.writeFileSync(archivePath, replacement);

      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((artifact) => artifact.path === archivePath)).toMatchObject({
        outcome: "blocked",
        reason: "artifact-metadata-changed",
      });
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(result.status).toBe("blocked");
      expect(result.totals.removedBytes).toBe(0);
      expect(fs.readFileSync(archivePath)).toEqual(replacement);
    },
  );

  it.each(["replacement", "symlink", "hardlink"])(
    "refuses a destination database %s introduced during confirmation",
    async (kind) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore();
      const databasePath = imported.targets[0]!.sqlitePath;
      const saved = path.join(store.tempDir, "saved-destination.sqlite");
      const original = fs.readFileSync(archivePath);
      await expect(
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => {
            if (kind === "hardlink") {
              fs.linkSync(databasePath, saved);
            } else {
              fs.renameSync(databasePath, saved);
              if (kind === "symlink") {
                fs.symlinkSync(saved, databasePath);
              } else {
                fs.copyFileSync(saved, databasePath);
              }
            }
            return true;
          },
        }),
      ).rejects.toThrow(/destination|symbolic|hard.link/i);
      expect(fs.readFileSync(archivePath)).toEqual(original);
    },
  );

  it.each(
    ["transcript", "legacy-store"].flatMap((artifactKind) =>
      ["replacement", "symlink", "hardlink", "same-size edit"].map((change) => ({
        artifactKind,
        change,
      })),
    ),
  )(
    "preserves every recovery dependency after a $artifactKind $change during confirmation",
    async ({ artifactKind, change }) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifestBefore = fs.readFileSync(manifestPath);
      const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
      const archivePath = expectDefined(
        moves.find((move) => move.kind === artifactKind),
        "confirmation mutation archive",
      ).archivePath;
      const retained = moves
        .filter((move) => move.archivePath !== archivePath)
        .map((move) => ({ path: move.archivePath, contents: fs.readFileSync(move.archivePath) }));
      const replacement = path.join(store.tempDir, "replacement");
      fs.writeFileSync(replacement, "unrelated bytes");
      await expect(
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => {
            if (change === "hardlink") {
              fs.linkSync(archivePath, path.join(store.tempDir, "alias"));
            } else if (change === "same-size edit") {
              const contents = fs.readFileSync(archivePath);
              contents[0] = 0x78;
              fs.writeFileSync(archivePath, contents);
            } else {
              fs.unlinkSync(archivePath);
              if (change === "symlink") {
                fs.symlinkSync(replacement, archivePath);
              } else {
                fs.writeFileSync(archivePath, "replacement original");
              }
            }
            return true;
          },
        }),
      ).rejects.toThrow(/selection changed|artifact/i);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.readFileSync(replacement, "utf8")).toBe("unrelated bytes");
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
      for (const artifact of retained) {
        expect(fs.readFileSync(artifact.path)).toEqual(artifact.contents);
      }
    },
  );

  it.each(
    ["in-place edit", "truncation", "WAL commit"].flatMap((change) =>
      ["confirmation", "publication", "unlink-intent"].map((phase) => ({ change, phase })),
    ),
  )("retains originals after destination $change during $phase", async ({ change, phase }) => {
    const { store, imported } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const target = readMigrationManifest(manifestPath).targets[0]!;
    const originals = target.completedMoves.map((move) => fs.readFileSync(move.archivePath));
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
        expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
        expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(32);
      } else if (change === "truncation") {
        fs.truncateSync(databasePath, 0);
      } else {
        const bytes = fs.readFileSync(databasePath);
        bytes[0] = 0;
        fs.writeFileSync(databasePath, bytes);
        fs.utimesSync(databasePath, before.atime, before.mtime);
        expect(fs.statSync(databasePath).size).toBe(bytes.length);
      }
      expect(fs.statSync(databasePath, { bigint: true }).ino).toBe(before.ino);
    };
    const mutateAfterSync = (directory: string) => {
      if (injected || phase === "confirmation") {
        return;
      }
      const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
      const atUnlink = moves.some(
        (move) =>
          move.artifact?.disposal.state === "pending-disposal" &&
          move.artifact.disposal.phase === "unlink-pending",
      );
      if (
        (phase === "publication" &&
          directory === path.dirname(target.completedMoves[0]!.archivePath)) ||
        (phase === "unlink-intent" && directory === path.dirname(manifestPath) && atUnlink)
      ) {
        mutate();
      }
    };
    const restoreSync = observeRecoveryDirectorySync(path.dirname(manifestPath), mutateAfterSync);
    try {
      const cleanup = retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => {
          if (phase === "confirmation") {
            mutate();
          }
          return true;
        },
      });
      if (phase === "confirmation") {
        await expect(cleanup).rejects.toThrow(/destination/i);
      } else {
        const result = await cleanup;
        expect(result.status).toBe("blocked");
        expect(result.totals.removedFiles).toBe(0);
      }
      expect(injected).toBe(true);
      for (const [index, move] of readMigrationManifest(
        manifestPath,
      ).targets[0]!.completedMoves.entries()) {
        const disposal = move.artifact!.disposal;
        expect(disposal.state).not.toBe("disposed");
        const retainedPath = fs.existsSync(move.archivePath)
          ? move.archivePath
          : disposal.state === "pending-disposal"
            ? disposal.claimPath
            : move.archivePath;
        expect(fs.readFileSync(retainedPath)).toEqual(originals[index]);
      }
    } finally {
      restoreSync();
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
      fs.writeFileSync(
        sibling,
        JSON.stringify({ type: "session", id: "second", version: 3 }) + "\n",
      );
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
      const changed = expectDefined(
        target.completedMoves.find((move) => move.sourcePath === sibling),
        "later transcript",
      );
      const originals = new Map(
        target.completedMoves.map((move) => [move.archivePath, fs.readFileSync(move.archivePath)]),
      );
      let injected = false;
      const mutateAfterSync = (directory: string) => {
        const moves = readMigrationManifest(manifestPath).targets[0]!.completedMoves;
        const atUnlink = moves.some(
          (move) =>
            move.artifact?.disposal.state === "pending-disposal" &&
            move.artifact.disposal.phase === "unlink-pending",
        );
        if (
          !injected &&
          ((phase === "intent-sync" && directory === path.dirname(manifestPath) && !atUnlink) ||
            (phase === "publication" && directory === path.dirname(changed.archivePath)) ||
            (phase === "unlink-intent" && directory === path.dirname(manifestPath) && atUnlink))
        ) {
          injected = true;
          const move = expectDefined(
            moves.find((mappedMove) => mappedMove.archivePath === changed.archivePath),
            "changed transcript receipt",
          );
          const disposal = move.artifact!.disposal;
          const file = fs.existsSync(move.archivePath)
            ? move.archivePath
            : disposal.state === "pending-disposal"
              ? disposal.claimPath
              : move.archivePath;
          fs.appendFileSync(file, "unique late history\n");
          originals.set(move.archivePath, fs.readFileSync(file));
        }
      };
      const restoreSync = observeRecoveryDirectorySync(path.dirname(manifestPath), mutateAfterSync);
      const invoke = () =>
        retireSessionSqliteRecovery({
          env: store.env,
          preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
          readConfig: async () => ({}),
          confirm: async () => true,
        });
      try {
        const result = await invoke();
        expect(injected).toBe(true);
        expect(result.status).toBe("blocked");
        expect(result.totals.removedFiles).toBe(0);
      } finally {
        restoreSync();
      }
      expect((await invoke()).totals.removedFiles).toBe(0);
      for (const move of readMigrationManifest(manifestPath).targets[0]!.completedMoves) {
        const disposal = move.artifact!.disposal;
        expect(disposal.state).not.toBe("disposed");
        const file = fs.existsSync(move.archivePath)
          ? move.archivePath
          : disposal.state === "pending-disposal"
            ? disposal.claimPath
            : move.archivePath;
        expect(fs.readFileSync(file)).toEqual(originals.get(move.archivePath));
      }
    },
  );
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
