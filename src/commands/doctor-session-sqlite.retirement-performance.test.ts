import fs from "node:fs";
import { expect, it, vi } from "vitest";
import * as fileDescriptor from "../infra/file-descriptor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import {
  retireSessionSqliteRecovery,
  type RecoveryCleanupProgress,
} from "./doctor-session-sqlite-retirement.js";
import {
  importLegacyStore,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

function transcript(content: string) {
  return [
    JSON.stringify({ type: "session", id: "session-1", version: 3 }),
    JSON.stringify({
      type: "message",
      id: "message-1",
      parentId: null,
      message: { role: "user", content },
    }),
  ];
}

it("hashes each original three times and reports progress while retiring a large recovery set", async () => {
  const { store } = await createVerifiedRecoveryStore(transcript("x".repeat(2 * 1024 * 1024)));
  const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
  const originals = preview.artifacts.filter((item) => item.outcome === "candidate");
  expect(originals).toHaveLength(2);
  const reads = new Map(
    originals.map((item) => {
      const stat = fs.statSync(item.path, { bigint: true });
      const read = { size: item.bytes, passes: 0, bytes: 0 };
      return [`${stat.dev}:${stat.ino}`, read] as const;
    }),
  );
  const hash = fileDescriptor.hashFileDescriptorSync;
  using hashSpy = vi.spyOn(fileDescriptor, "hashFileDescriptorSync");
  hashSpy.mockImplementation((fd, maxBytes) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    const result = hash(fd, maxBytes);
    const read = reads.get(`${stat.dev}:${stat.ino}`);
    if (read) {
      read.passes += 1;
      read.bytes += result.sizeBytes;
    }
    return result;
  });
  const progress: RecoveryCleanupProgress[] = [];
  const result = await retireSessionSqliteRecovery({
    env: store.env,
    preview,
    readConfig: async () => ({}),
    confirm: async () => true,
    onProgress: (event) => {
      // Progress describes work before effect, including while originals still exist.
      expect(fs.existsSync(event.path)).toBe(true);
      progress.push(event);
    },
  });
  expect(result.status).toBe("complete");
  expect(result.totals.removedFiles).toBe(2);
  expect(result.totals.removedBytes).toBe(preview.totals.candidateBytes);
  for (const read of reads.values()) {
    expect(read.passes).toBe(3);
    expect(read.bytes).toBe(3 * read.size);
  }
  expect(progress).toEqual(
    ["verifying", "claiming"].flatMap((phase) =>
      originals.map((item, index) => ({
        phase,
        path: item.path,
        index: index + 1,
        total: 2,
        bytes: item.bytes,
      })),
    ),
  );
  expect(originals.every((item) => !fs.existsSync(item.path))).toBe(true);
});

it("rehashes an original edited in place with restored mtime after initial verification", async () => {
  const store = createLegacyStore({ transcriptLines: transcript("original content") });
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(store.transcriptPath, timestamp, timestamp);
  const imported = await importLegacyStore(store);
  expect(imported.targets[0]?.issues).toEqual([]);
  closeOpenClawAgentDatabasesForTest();
  const moves = readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]!
    .completedMoves;
  const original = moves.find((move) => move.kind === "transcript")!;
  const before = fs.statSync(original.archivePath, { bigint: true });
  const bytes = fs.readFileSync(original.archivePath);
  bytes[0] = 0x78;
  await expect(
    retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => {
        fs.writeFileSync(original.archivePath, bytes);
        fs.utimesSync(original.archivePath, timestamp, timestamp);
        const after = fs.statSync(original.archivePath, { bigint: true });
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(before.size);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        return true;
      },
    }),
  ).rejects.toThrow("artifact identity or contents changed");
  expect(fs.readFileSync(original.archivePath)).toEqual(bytes);
  expect(moves.every((move) => fs.existsSync(move.archivePath))).toBe(true);
});
