import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getSessionColdStorageStatus } from "./session-cold-storage-status.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { historyLane, targetDiscoveryLane } from "./session-transcript-worker-resources.js";

let state: OpenClawTestState;
let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
let embeddedBytes: number;
let embeddedBlob: Buffer;
const status = (storePath = fixture.scope.storePath) =>
  getSessionColdStorageStatus(maintenanceConfig(storePath));
function setStorage(db: ReturnType<typeof openNodeSqliteDatabase>, storage: "sqlite" | "file") {
  db.prepare(
    "UPDATE session_transcript_cold_archives SET storage = ?, archive_blob = ? WHERE session_id = ?",
  ).run(storage, storage === "sqlite" ? embeddedBlob : null, historicalId);
}
const emptyInventory = (storePath: string) => ({
  agentId: "main",
  storePath,
  hotTranscripts: 0,
  coldTranscripts: 0,
  embeddedArchiveBytes: 0,
  archiveBytes: 0,
  databaseBytes: 0,
  walBytes: 0,
});
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  fixture = await createSessionColdStorageFixture(state.statePath("shared.sqlite"));
  await runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) });
  const db = fixture.database();
  const descriptor = db
    .prepare(
      "SELECT archive_name, archive_bytes FROM session_transcript_cold_archives WHERE session_id = ?",
    )
    .get(historicalId)!;
  embeddedBytes = Number(descriptor.archive_bytes);
  embeddedBlob = await fs.readFile(
    path.join(state.stateDir, "cold", String(descriptor.archive_name)),
  );
  setStorage(db, "sqlite");
  await closeOpenClawAgentDatabasesAsync();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => state.cleanup());

it.each(["sqlite", "file"] as const)(
  "reports current %s archive storage without parent SQLite",
  async (storage) => {
    const missing = state.statePath("missing", "openclaw-agent.sqlite");
    const foreign =
      storage === "file" ? openNodeSqliteDatabase(fixture.scope.storePath) : undefined;
    if (foreign) {
      setStorage(foreign, "file");
    }
    const observer = observeParentSqlite();
    try {
      const config = maintenanceConfig(fixture.scope.storePath);
      if (storage === "sqlite") {
        config.agents = {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, other: {} },
        };
      }
      const result = await getSessionColdStorageStatus(config);
      expect(result).toEqual([
        {
          ...emptyInventory(fixture.scope.storePath),
          hotTranscripts: 1,
          coldTranscripts: 1,
          embeddedArchiveBytes: storage === "sqlite" ? embeddedBytes : 0,
          archiveBytes: embeddedBytes,
          databaseBytes: expect.any(Number),
          walBytes: expect.any(Number),
        },
      ]);
      expect(result[0]!.databaseBytes).toBeGreaterThan(0);
      if (storage === "sqlite") {
        expect(await status(missing)).toEqual([emptyInventory(missing)]);
        await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
      if (foreign) {
        setStorage(foreign, "sqlite");
        foreign.close();
      }
    }
  },
);

it("refuses a replaced source while its worker inventory is delayed", async () => {
  const missing = state.statePath("delayed", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(missing), { recursive: true });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = targetDiscoveryLane.pool.run.bind(targetDiscoveryLane.pool);
  vi.spyOn(targetDiscoveryLane.pool, "run").mockImplementation(async (...args) => {
    const reply = await run(...args);
    if (
      reply.ok &&
      typeof reply.value === "object" &&
      !Array.isArray(reply.value) &&
      "kind" in reply.value &&
      reply.value.kind === "cold-storage-inventory"
    ) {
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  const pending = status(missing);
  const outcome = pending.catch((error: unknown) => error);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Inventory was not dispatched");
    await fs.writeFile(missing, "replacement source");
    release.resolve();
    await expect(pending).rejects.toThrow(/Session store changed/);
  } finally {
    release.resolve();
    await outcome;
    await fs.unlink(missing).catch(() => {});
  }
});

it("propagates worker rejection without a synchronous fallback", async () => {
  const failure = new Error("inventory worker refused");
  vi.spyOn(historyLane.pool, "run").mockRejectedValueOnce(failure);
  const observer = observeParentSqlite();
  try {
    await expect(status()).rejects.toBe(failure);
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    observer.restore();
  }
});
