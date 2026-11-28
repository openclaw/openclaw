import fs from "node:fs";
import { expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { importManifest, messageEvent } from "./doctor-session-sqlite.fixtures.test-support.js";
import { useDoctorSessionSqliteTestFixture } from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

function transcript(content: string) {
  return [
    JSON.stringify({ type: "session", id: "session-1", version: 3 }),
    JSON.stringify(messageEvent("message-1", "user", content)),
  ];
}

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
      preview: await inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
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
