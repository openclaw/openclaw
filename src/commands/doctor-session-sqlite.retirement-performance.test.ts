import fs from "node:fs";
import { expect, it, vi } from "vitest";
import * as fileDescriptor from "../infra/file-descriptor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { importManifest, messageEvent } from "./doctor-session-sqlite.fixtures.test-support.js";
import { useDoctorSessionSqliteTestFixture } from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

function transcript(content: string) {
  return [
    JSON.stringify({ type: "session", id: "session-1", version: 3 }),
    JSON.stringify(messageEvent("message-1", "user", content)),
  ];
}

it("hashes each original three times and reports progress while retiring a large recovery set", async () => {
  const { store } = await createVerifiedRecoveryStore(transcript("x".repeat(2 * 1024 * 1024)));
  const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
  const originals = preview.artifacts
    .filter((item) => item.outcome === "candidate")
    .map((item) => Object.assign({ stat: fs.statSync(item.path, { bigint: true }) }, item));
  expect(originals).toHaveLength(2);
  const reads: Array<{ dev: bigint; ino: bigint; bytes: number }> = [];
  const hash = fileDescriptor.hashFileDescriptorSync;
  using hashSpy = vi.spyOn(fileDescriptor, "hashFileDescriptorSync");
  hashSpy.mockImplementation((fd, maxBytes) => {
    const { dev, ino } = fs.fstatSync(fd, { bigint: true });
    const result = hash(fd, maxBytes);
    reads.push({ dev, ino, bytes: result.sizeBytes });
    return result;
  });
  const progress: Parameters<
    NonNullable<Parameters<typeof retireSessionSqliteRecovery>[0]["onProgress"]>
  >[0][] = [];
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
  expect(result).toMatchObject({
    status: "complete",
    totals: { removedFiles: 2, removedBytes: preview.totals.candidateBytes },
  });
  for (const item of originals) {
    expect(
      reads
        .filter(({ dev, ino }) => dev === item.stat.dev && ino === item.stat.ino)
        .map(({ bytes }) => bytes),
    ).toEqual([item.bytes, item.bytes, item.bytes]);
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
  const { imported, target } = await importManifest(store);
  expect(imported.targets[0]?.issues).toEqual([]);
  closeOpenClawAgentDatabasesForTest();
  const moves = target.completedMoves;
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
        expect(fs.statSync(original.archivePath, { bigint: true })).toMatchObject({
          ino: before.ino,
          size: before.size,
          mtimeNs: before.mtimeNs,
        });
        return true;
      },
    }),
  ).rejects.toThrow("artifact identity or contents changed");
  expect(fs.readFileSync(original.archivePath)).toEqual(bytes);
  expect(moves.every((move) => fs.existsSync(move.archivePath))).toBe(true);
});
