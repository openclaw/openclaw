import syncFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
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
  const directory = state.statePath("cold");
  const archives = (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl.zst"));
  expect(archives).toHaveLength(1);
  embeddedBlob = await fs.readFile(path.join(directory, archives[0]!));
  embeddedBytes = embeddedBlob.length;
  setStorage(fixture.database(), "sqlite");
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
      onTestFinished(() => {
        setStorage(foreign, "sqlite");
        foreign.close();
      });
    }
    const observer = observeParentSqlite();
    onTestFinished(observer.restore);
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
  onTestFinished(observer.restore);
  await expect(status()).rejects.toBe(failure);
  expect(observer.counts).toEqual(emptySqliteCounts());
});

it("reads cold storage status without synchronous filesystem work on the host", async () => {
  await status();
  const calls = new Map<string, { operation: string; count: number; stack: string }>();
  const restores: Array<() => void> = [];
  const wrap = (owner: object, name: string, operation = name) => {
    const original: unknown = Reflect.get(owner, name);
    if (typeof original !== "function") {
      return;
    }
    Reflect.set(
      owner,
      name,
      new Proxy(original, {
        apply(target, receiver, args) {
          const stack = new Error().stack ?? "";
          const key = `${operation}\n${stack}`;
          const row = calls.get(key) ?? { operation, count: 0, stack };
          row.count += 1;
          calls.set(key, row);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    restores.push(() => {
      Reflect.set(owner, name, original);
    });
  };
  for (const name of Object.keys(syncFs)) {
    if (name.endsWith("Sync")) {
      wrap(syncFs, name);
    }
  }
  wrap(syncFs.realpathSync, "native", "realpathSync.native");
  syncBuiltinESMExports();
  try {
    const result = await status();
    expect(result).toEqual([
      expect.objectContaining({
        agentId: "main",
        storePath: fixture.scope.storePath,
        hotTranscripts: 1,
        coldTranscripts: 1,
        embeddedArchiveBytes: embeddedBytes,
      }),
    ]);
    expect([...calls.values()]).toEqual([]);
  } finally {
    for (const restore of restores.toReversed()) {
      restore();
    }
    syncBuiltinESMExports();
  }
});

it("keeps the host's configured refusal selection during worker preparation", async () => {
  const store = state.statePath("refused-selection", "{agentId}.sqlite");
  const helper = state.statePath("refused-selection", "helper.sqlite");
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.writeFile(helper, "unavailable database");
  recordAgentDatabaseAdmissions(
    [
      createAgentDatabaseInspectionRefusal({
        agentId: "helper",
        paths: [helper],
        reason: "fixture inspection failed",
      }),
    ],
    { env: state.env },
  );
  try {
    const config = maintenanceConfig(store);
    config.agents.entries = { main: {}, helper: {} };
    await expect(getSessionColdStorageStatus(config)).resolves.toEqual([
      emptyInventory(state.statePath("refused-selection", "main.sqlite")),
    ]);
  } finally {
    recordAgentDatabaseAdmissions([], { env: state.env });
  }
});
