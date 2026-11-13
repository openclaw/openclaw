import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OpenClawStateExternalOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  NodeWorkerLaunchKernel,
  readNodeWorkerLaunchReceipt,
} from "./node-worker-launch-store.kernel.js";
import {
  recordNodeWorkerDescendantsReaped,
  recordNodeWorkerLineageSettled,
} from "./node-worker-lineage-completion.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import * as workerProcessIdentity from "./node-worker-process-identity.js";
import { projectNodeWorkerSupervisorReceipt } from "./node-worker-supervisor-contract.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { writeNodeWorkerFixture } from "./node-worker-supervisor.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 10 * DAY_MS;
type Database = ReturnType<typeof openOpenClawStateDatabase>["db"];
const containerIdentity = {
  engine: "docker",
  containerId: "a".repeat(64),
  engineTarget: "b".repeat(64),
} as const;
const launchClaim = (launchId: string, planHash = "a".repeat(64)) => ({
  launchId,
  planHash,
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  ownerEpoch: 3,
  placementGeneration: 4,
  runId: "run-1",
});
async function closeDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
function schema(database: Database, name: string) {
  return database.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name);
}
function tableIds(database: Database, table: string) {
  return (
    database.prepare(`SELECT launch_id FROM ${table} ORDER BY launch_id`).all() as Array<{
      launch_id: string;
    }>
  ).map((row) => row.launch_id);
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    cleanup();
  }),
);

async function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-launch-store-") };
  const journal = new NodeWorkerJournalWorker({ env });
  const store = new NodeWorkerLaunchStore(journal);
  await store.get("schema-probe");
  return { database: openOpenClawStateDatabase({ env }).db, env, journal, store };
}

function insertLaunch(
  database: Database,
  launchId: string,
  state: "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled",
  completedAtMs = NOW_MS,
  planHash = "a".repeat(64),
) {
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  const terminal = state !== "pending" && state !== "running";
  const completed = terminal ? completedAtMs : null;
  database
    .prepare(
      `INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'gateway-1', 'environment-1', 'session-1', 3, 4, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      launchId,
      planHash,
      state,
      processIdentity.pid,
      processIdentity.startTime,
      state === "running" ? processIdentity.pid : null,
      state === "running" ? processIdentity.startTime : null,
      state === "completed" ? '{"status":"completed"}' : null,
      terminal && state !== "completed" ? `worker ${state}` : null,
      completed,
      completed ?? 1,
    );
}

function hasSchemaObject(database: Database, type: "index" | "table", name: string) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name),
  );
}
const hasExpiryIndex = (db: Database) =>
  hasSchemaObject(db, "index", "idx_node_worker_launches_terminal_completed");
const hasContainers = (db: Database) =>
  hasSchemaObject(db, "table", "node_worker_launch_containers");

const launchIds = (database: Database) => tableIds(database, "node_worker_launches");

describe("node worker launch admitted schema", () => {
  function kernelFixture(seed = true) {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-launch-schema-") };
    const opened = openOpenClawStateDatabase({ env });
    const kernel = new NodeWorkerLaunchKernel({ database: opened, env });
    const admission = vi
      .spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => {});
    kernel.get("schema-probe");
    if (seed) {
      insertLaunch(opened.db, "schema-launch", "pending");
    }
    return { ...opened, opened, env, kernel, admission };
  }

  it("refreshes lazy companion facts after a transaction rollback", () => {
    const { opened, env, kernel, admission } = kernelFixture();
    try {
      const pending = kernel.get("schema-launch")!;
      const start = () =>
        kernel.markRunning({
          ...pending,
          worker: pending.supervisor,
          cleanupMode: "linux-subreaper",
          nowMs: NOW_MS,
        });
      const rollback = new Error("roll back first-use companion DDL");
      expect(() =>
        runOpenClawStateWriteTransaction(
          () => {
            expect(start()).toMatchObject({
              workerCleanupMode: "linux-subreaper",
              workerDescendantsReaped: false,
            });
            throw rollback;
          },
          { database: opened, env },
        ),
      ).toThrow(rollback);
      expect(kernel.get(pending.launchId)).toEqual(pending);
      const running = start();
      expect(running.workerCleanupMode).toBe("linux-subreaper");
      expect(running.workerDescendantsReaped).toBe(false);
      expect(kernel.listNonterminal()).toEqual([running]);
    } finally {
      admission.mockRestore();
    }
  });

  it("observes foreign companion row commits after the current snapshot without inventing certificates", () => {
    const { db, path, kernel, admission } = kernelFixture();
    // Native connection bypasses in-process schema publications, like a separate worker.
    const foreign = new (requireNodeSqlite().DatabaseSync)(path);
    const write = (sql: string, ...values: Array<string | number | null>) =>
      foreign.prepare(sql).run(...values);
    try {
      const pending = kernel.get("schema-launch")!;
      const legacy = kernel.markRunning({
        ...pending,
        worker: pending.supervisor,
        cleanupMode: "owned-anchor",
        nowMs: NOW_MS,
      });
      expect(legacy.workerDescendantsReaped).toBeUndefined();
      db.exec(
        extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "node_worker_launch_process_scopes"),
      );
      db.exec("BEGIN");
      try {
        expect(readNodeWorkerLaunchReceipt(db, legacy.launchId)).toEqual(legacy);
        write(
          "INSERT INTO node_worker_launch_process_scopes (launch_id, scope_kind, descendants_reaped) VALUES (?, 'linux-subreaper', NULL)",
          legacy.launchId,
        );
        expect(readNodeWorkerLaunchReceipt(db, legacy.launchId)).toEqual(legacy);
      } finally {
        db.exec("COMMIT");
      }
      const current = kernel.get(legacy.launchId)!;
      expect(current).toEqual({
        ...legacy,
        workerCleanupMode: "linux-subreaper",
        workerDescendantsReaped: false,
      });
      write(
        "UPDATE node_worker_launch_process_scopes SET descendants_reaped = 1 WHERE launch_id = ?",
        legacy.launchId,
      );
      expect(kernel.listNonterminal()).toEqual([{ ...current, workerDescendantsReaped: true }]);
      write("DELETE FROM node_worker_launch_process_scopes WHERE launch_id = ?", legacy.launchId);
      expect(kernel.get(legacy.launchId)).toEqual(legacy);
    } finally {
      foreign.close();
      admission.mockRestore();
    }
  });
  function claimFixture() {
    const value = kernelFixture(false);
    const previous = requireNodeWorkerProcessIdentity(process.pid);
    const supervisor = { pid: previous.pid, startTime: previous.startTime + 1 };
    return { ...value, previous, supervisor, claim: launchClaim("count-launch") };
  }

  it.each(["old-boot", null, undefined])(
    "preserves the physical row and current companions when reclaim matches no row (%s)",
    (bootId) => {
      const { path, kernel, previous, supervisor, claim } = claimFixture();
      kernel.claim(claim, previous, 10, NOW_MS, undefined, undefined, "old-boot");
      kernel.markRunning({
        ...claim,
        supervisor: previous,
        worker: previous,
        cleanupMode: "linux-subreaper",
        container: { engine: "docker", containerId: "b".repeat(64), engineTarget: "c".repeat(64) },
        nowMs: NOW_MS + 7,
      });
      const foreign = new (requireNodeSqlite().DatabaseSync)(path);
      const write = (sql: string, ...values: Array<string | number | null>) =>
        foreign.prepare(sql).run(...values);
      try {
        write(
          "UPDATE node_worker_launches SET state = 'pending', worker_pid = NULL, worker_start_time = NULL WHERE launch_id = ?",
          claim.launchId,
        );
        const observed = kernel.claimObservation(claim, supervisor, 10, NOW_MS);
        const container = {
          engine: "docker",
          containerId: "d".repeat(64),
          engineTarget: "e".repeat(64),
        };
        write(
          "UPDATE node_worker_launch_containers SET container_json = ? WHERE launch_id = ?",
          JSON.stringify(container),
          claim.launchId,
        );
        write(
          "UPDATE node_worker_launch_cleanup SET lineage_settled = 1 WHERE launch_id = ?",
          claim.launchId,
        );
        write(
          "UPDATE node_worker_launch_process_scopes SET descendants_reaped = 1 WHERE launch_id = ?",
          claim.launchId,
        );
        if (bootId === undefined) {
          write("DELETE FROM node_worker_launch_boots WHERE launch_id = ?", claim.launchId);
        } else {
          write(
            "UPDATE node_worker_launch_boots SET boot_id = ? WHERE launch_id = ?",
            bootId,
            claim.launchId,
          );
        }
        // Suppress the physical write without creating a row that violates its CHECKs.
        foreign.exec(`CREATE TRIGGER skip_reclaim BEFORE UPDATE OF supervisor_pid
          ON node_worker_launches BEGIN SELECT RAISE(IGNORE); END`);
        const result = kernel.claim(
          claim,
          supervisor,
          10,
          NOW_MS + 20,
          observed,
          "reused",
          "new-boot",
        );
        expect(result).toMatchObject({
          action: "replay",
          nonterminalCount: 1,
          receipt: {
            state: "pending",
            supervisor: previous,
            worker: null,
            updatedAtMs: NOW_MS + 7,
            workerCleanupMode: "linux-subreaper",
            workerLineageSettled: true,
            workerDescendantsReaped: true,
            container,
          },
        });
        if (bootId) {
          expect(result).toHaveProperty("receipt.bootId", "new-boot");
        } else {
          expect(result).not.toHaveProperty("receipt.bootId");
        }
        expect(result).toEqual({
          action: "replay",
          nonterminalCount: 1,
          receipt: kernel.get(claim.launchId),
        });
      } finally {
        foreign.close();
      }
    },
  );
});

describe("node worker launch store pruning", () => {
  it("lazily repairs released journals without rewriting old receipts or advancing the schema", async () => {
    const { database, env, store } = await fixture();
    insertLaunch(database, "released-worker", "running");
    const releasedReceipt = await store.get("released-worker");
    const versionBefore = database.prepare("PRAGMA user_version").get();
    expect(hasExpiryIndex(database)).toBe(true);
    database.exec("DROP INDEX idx_node_worker_launches_terminal_completed");
    expect(hasExpiryIndex(database)).toBe(false);
    await closeDatabase();

    const reopenedStore = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    expect(await reopenedStore.get("released-worker")).toEqual(releasedReceipt);
    const reopened = openOpenClawStateDatabase({ env }).db;

    expect(hasExpiryIndex(reopened)).toBe(true);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      reopened
        .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
        .get("node_worker_launch_cleanup"),
    ).toBeUndefined();
    const launchSql = schema(reopened, "node_worker_launches")?.sql;
    const { planHash, supervisor } = await claimLaunch(reopenedStore, "current-worker");
    await reopenedStore.markRunning({
      launchId: "current-worker",
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode: "process-group",
      nowMs: NOW_MS,
    });
    expect(await reopenedStore.get("released-worker")).toEqual(releasedReceipt);
    expect(schema(reopened, "node_worker_launches")?.sql).toBe(launchSql);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    insertLaunch(reopened, "older-writer", "running");
    expect(await reopenedStore.get("older-writer")).toMatchObject({
      workerCleanupMode: null,
      workerLineageSettled: false,
    });
  });

  it("records Windows Job custody in the existing cleanup table without certifying old receipts", async () => {
    const { database, store } = await fixture();
    database.exec(`
      CREATE TABLE node_worker_launch_cleanup (
        launch_id TEXT NOT NULL PRIMARY KEY
          REFERENCES node_worker_launches(launch_id) ON DELETE CASCADE,
        cleanup_mode TEXT NOT NULL CHECK (cleanup_mode IN ('process-group', 'owned-anchor')),
        lineage_settled INTEGER CHECK (lineage_settled IS NULL OR lineage_settled = 1)
      ) STRICT;
    `);
    const schemaBefore = schema(database, "node_worker_launch_cleanup");
    const boot = vi
      .spyOn(workerProcessIdentity, "getNodeWorkerBootIdentity")
      .mockReturnValue("win32:test-boot");
    const previous = await claimLaunch(store, "old-windows-worker");
    await store.markRunning({
      launchId: "old-windows-worker",
      ...previous,
      worker: previous.supervisor,
      cleanupMode: "process-group",
    });
    const current = await claimLaunch(store, "job-worker");
    boot.mockRestore();
    await store.markRunning({
      launchId: "job-worker",
      ...current,
      worker: current.supervisor,
      cleanupMode: "windows-job",
    });
    expect(await store.get("old-windows-worker")).toMatchObject({
      state: "running",
      workerCleanupMode: "process-group",
    });
    expect(await store.get("job-worker")).toMatchObject({
      state: "running",
      workerCleanupMode: "windows-job",
    });
    expect(schema(database, "node_worker_launch_cleanup")).toEqual(schemaBefore);
  });

  it("prunes only the oldest expired terminal receipts in bounded batches", async () => {
    const { database, store } = await fixture();
    insertLaunch(database, "old-completed", "completed", 1);
    insertLaunch(database, "old-failed", "failed", 2);
    insertLaunch(database, "old-cancelled", "cancelled", 3);
    insertLaunch(database, "recent-completed", "completed", NOW_MS - 1_000);
    insertLaunch(database, "pending", "pending");
    insertLaunch(database, "running", "pending");
    const supervisor = requireNodeWorkerProcessIdentity(process.pid);
    const container = containerIdentity;
    await store.markRunning({
      launchId: "running",
      planHash: "a".repeat(64),
      supervisor,
      worker: supervisor,
      cleanupMode: null,
      container,
      nowMs: NOW_MS,
    });
    const insertContainer = database.prepare(
      "INSERT INTO node_worker_launch_containers (launch_id, container_json) VALUES (?, ?)",
    );
    for (const launchId of ["old-completed", "old-failed", "old-cancelled", "recent-completed"]) {
      insertContainer.run(launchId, JSON.stringify(container));
    }
    const containerLaunchIds = () => tableIds(database, "node_worker_launch_containers");
    expect(await store.nonterminalCount()).toBe(2);

    expect(await store.pruneExpiredTerminal({ nowMs: NOW_MS, limit: 2 })).toBe(2);
    expect(launchIds(database)).toEqual([
      "old-cancelled",
      "pending",
      "recent-completed",
      "running",
    ]);
    expect(containerLaunchIds()).toEqual(["old-cancelled", "recent-completed", "running"]);

    expect(await store.pruneExpiredTerminal({ nowMs: NOW_MS, limit: 2 })).toBe(1);
    expect(launchIds(database)).toEqual(["pending", "recent-completed", "running"]);
    expect(containerLaunchIds()).toEqual(["recent-completed", "running"]);
  });

  it("prunes expired terminal receipts after restart reconciliation", async () => {
    const workerFixture = writeNodeWorkerFixture(tempDirs.make("node-worker-launch-restart-"));
    const store = new NodeWorkerLaunchStore(
      new NodeWorkerJournalWorker({ env: workerFixture.env }),
    );
    await store.get("schema-probe");
    const database = openOpenClawStateDatabase({ env: workerFixture.env }).db;
    insertLaunch(database, "expired-after-restart", "completed", 1);
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot: workerFixture.bundleRoot,
      env: workerFixture.env,
    });
    try {
      await supervisor.initialize();
      expect(await store.get("expired-after-restart")).toBeUndefined();
    } finally {
      await supervisor.close();
    }
  });

  it("keeps the exact replay fence while a new claim prunes unrelated receipts", async () => {
    const { database, store } = await fixture();
    const planHash = "b".repeat(64);
    insertLaunch(database, "replayed-launch", "completed", 1, planHash);
    insertLaunch(database, "stale-launch", "completed", 2);
    const supervisor = requireNodeWorkerProcessIdentity(process.pid);

    expect(
      await store.claim(launchClaim("replayed-launch", planHash), supervisor, 2, NOW_MS),
    ).toMatchObject({ action: "replay", receipt: { state: "completed" } });
    expect(launchIds(database)).toEqual(["replayed-launch"]);
  });
});

async function claimLaunch(store: NodeWorkerLaunchStore, launchId: string) {
  const supervisor = requireNodeWorkerProcessIdentity(process.pid);
  const planHash = "a".repeat(64);
  const result = await store.claim(launchClaim(launchId, planHash), supervisor, 2, NOW_MS);
  expect(result).toMatchObject({
    action: "start",
    receipt: { state: "pending", updatedAtMs: NOW_MS },
  });
  return { planHash, supervisor };
}

describe("node worker terminal ownership", () => {
  it.each(["finish", "cancel"] as const)(
    "keeps the physical reservation when %s comes from a stale process owner",
    async (operation) => {
      const { database, store } = await fixture();
      insertLaunch(database, "owned-launch", "running");
      const running = (await store.get("owned-launch"))!;
      const finish = async (ownership: Pick<typeof running, "supervisor" | "worker">) =>
        operation === "cancel"
          ? await store.finishCancelled({ expected: running, ...ownership })
          : await store.finish({
              launchId: running.launchId,
              planHash: running.planHash,
              ...ownership,
              state: "failed",
              errorText: "worker failed",
            });

      for (const field of ["supervisor", "worker"] as const) {
        for (const identityField of ["pid", "startTime"] as const) {
          const stale = {
            ...running[field]!,
            [identityField]: running[field]![identityField] + 1,
          };
          expect(await finish({ ...running, [field]: stale })).toEqual(running);
        }
      }
      expect(await finish({ ...running, worker: null })).toEqual(running);
      expect(await store.get(running.launchId)).toEqual(running);
      expect(await store.nonterminalCount()).toBe(1);
      const terminal = await finish(running);
      expect(terminal?.state).toBe(operation === "cancel" ? "cancelled" : "failed");
      expect(await store.get(running.launchId)).toEqual(terminal);
      expect(await store.nonterminalCount()).toBe(0);
    },
  );
});

describe("node worker launch store container identity", () => {
  it.each([false, true])(
    "preserves lazy container identity across reopen (container: %s)",
    async (withContainer) => {
      const { database, env, store } = await fixture();
      expect(hasContainers(database)).toBe(false);
      const initialSchemaVersion = database.prepare("PRAGMA user_version").get();
      const launchId = withContainer ? "container-launch" : "bare-launch";
      const { planHash, supervisor } = await claimLaunch(store, launchId);
      const container = withContainer ? containerIdentity : undefined;

      const receipt = await store.markRunning({
        launchId,
        planHash,
        supervisor,
        worker: supervisor,
        cleanupMode: withContainer ? null : "process-group",
        ...(container ? { container } : {}),
        nowMs: NOW_MS,
      });

      expect(hasContainers(database)).toBe(withContainer);
      if (withContainer) {
        expect(receipt.container).toEqual(container);
        expect(database.prepare("PRAGMA user_version").get()).toEqual(initialSchemaVersion);
      } else {
        expect(Object.hasOwn(receipt, "container")).toBe(false);
        expect(await store.get(launchId)).toEqual(receipt);
      }
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      const reopened = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
      expect(await reopened.get(launchId)).toEqual(receipt);
      if (!withContainer) {
        expect(hasContainers(openOpenClawStateDatabase({ env }).db)).toBe(false);
        return;
      }
      const completed = await reopened.finish({
        launchId: receipt.launchId,
        planHash: receipt.planHash,
        supervisor: receipt.supervisor,
        worker: receipt.worker,
        state: "completed",
        resultJson: "{}",
        nowMs: NOW_MS + 1,
      });
      expect(completed).toEqual({
        ...receipt,
        state: "completed",
        resultJson: "{}",
        completedAtMs: NOW_MS + 1,
        updatedAtMs: NOW_MS + 1,
      });
      expect(await reopened.get(launchId)).toEqual(completed);
    },
  );

  it.each([
    ["missing container id", { ...containerIdentity, containerId: undefined }],
    ["missing engine target", { ...containerIdentity, engineTarget: undefined }],
    ["unknown engine", { ...containerIdentity, engine: "runc" }],
    ["ambiguous container id prefix", { ...containerIdentity, containerId: "a".repeat(12) }],
    ["invalid engine target", { ...containerIdentity, engineTarget: "b".repeat(12) }],
    ["unexpected identity field", { ...containerIdentity, extra: true }],
  ])("fails closed when a persisted container identity has %s", async (_reason, malformed) => {
    const { database, store } = await fixture();
    const { planHash, supervisor } = await claimLaunch(store, "corrupt-container-launch");
    await store.markRunning({
      launchId: "corrupt-container-launch",
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode: null,
      container: containerIdentity,
      nowMs: NOW_MS,
    });
    database
      .prepare("UPDATE node_worker_launch_containers SET container_json = ? WHERE launch_id = ?")
      .run(JSON.stringify(malformed), "corrupt-container-launch");

    await expect(store.listNonterminal()).rejects.toThrow(
      /node worker container (identity|id|engine target)/u,
    );
  });
});

describe("node worker cleanup journal", () => {
  async function runningAnchor(cleanupMode: "owned-anchor" | "linux-subreaper" = "owned-anchor") {
    const { database, env, store } = await fixture();
    const launchId = "anchor-launch";
    const boot = vi
      .spyOn(workerProcessIdentity, "getNodeWorkerBootIdentity")
      .mockReturnValue("linux:test-boot");
    const { planHash, supervisor } = await claimLaunch(store, launchId).finally(() =>
      boot.mockRestore(),
    );
    const binding = await store.cleanupBinding({ launchId, planHash, supervisor });
    const receipt = await store.markRunning({
      launchId,
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode,
      nowMs: NOW_MS,
    });
    return { database, env, store, binding, receipt };
  }

  it("keeps native extinction distinct from old lineage receipts across reopen and retention", async () => {
    const { database, env, store, binding, receipt } = await runningAnchor("linux-subreaper");
    const version = database.prepare("PRAGMA user_version").get();
    expect(receipt).toMatchObject({
      workerCleanupMode: "linux-subreaper",
      workerDescendantsReaped: false,
      workerLineageSettled: false,
    });
    expect(recordNodeWorkerLineageSettled(binding)).toBe(false);
    expect(recordNodeWorkerDescendantsReaped(binding)).toBe(true);
    expect(await store.nonterminalCount()).toBe(1);
    // A downgraded reader sees its unchanged representation, never a forged
    // lineage completion standing in for a kernel tree certificate.
    expect(
      database
        .prepare(
          "SELECT cleanup_mode, lineage_settled FROM node_worker_launch_cleanup WHERE launch_id = ?",
        )
        .get(binding.launchId),
    ).toEqual({ cleanup_mode: "owned-anchor", lineage_settled: null });
    await closeDatabase();
    const reopened = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    expect(await reopened.get(binding.launchId)).toEqual({
      ...receipt,
      workerDescendantsReaped: true,
    });
    const db = openOpenClawStateDatabase({ env }).db;
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    await reopened.finish({
      ...binding,
      worker: receipt.worker,
      state: "interrupted",
      errorText: "scope retired",
      nowMs: NOW_MS,
    });
    expect(recordNodeWorkerDescendantsReaped(binding)).toBe(false);
    expect(await reopened.pruneExpiredTerminal({ nowMs: NOW_MS + DAY_MS })).toBe(1);
    expect(
      db.prepare("SELECT count(*) AS count FROM node_worker_launch_process_scopes").get(),
    ).toEqual({ count: 0 });
  });

  it("does not broaden a cleanup binding when ambient external mode changes", async () => {
    const { database, env, binding } = await runningAnchor();
    claimOpenClawStateOwnership("node-recovery-test", {
      env: { ...env, OPENCLAW_SUPERVISOR_MODE: "external" },
    });
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    try {
      expect(() => recordNodeWorkerLineageSettled(binding)).toThrow(
        OpenClawStateExternalOwnershipError,
      );
      expect(
        database
          .prepare("SELECT lineage_settled FROM node_worker_launch_cleanup WHERE launch_id = ?")
          .get(binding.launchId),
      ).toEqual({ lineage_settled: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not recreate a removed journal when an anchor reports completion", async () => {
    const { binding } = await runningAnchor();
    await closeDatabase();
    fs.unlinkSync(binding.databasePath);
    expect(() => recordNodeWorkerLineageSettled(binding)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(fs.existsSync(binding.databasePath)).toBe(false);
  });

  it("persists positive lineage completion on the exact database without releasing its slot or changing the wire receipt", async () => {
    const { env, store, binding, receipt } = await runningAnchor();
    expect(binding.databasePath).toBe(openOpenClawStateDatabase({ env }).path);
    expect(receipt.workerCleanupMode).toBe("owned-anchor");
    expect(receipt.workerLineageSettled).toBe(false);
    expect(recordNodeWorkerLineageSettled(binding)).toBe(true);
    expect(recordNodeWorkerLineageSettled(binding)).toBe(true);
    // A released journal cannot reinterpret lineage completion as native extinction.
    expect(() => recordNodeWorkerDescendantsReaped(binding)).toThrow(
      /missing table node_worker_launch_process_scopes/u,
    );
    expect(await store.get(binding.launchId)).toMatchObject({
      workerCleanupMode: "owned-anchor",
      workerLineageSettled: true,
    });
    expect((await store.get(binding.launchId))?.workerDescendantsReaped).toBeUndefined();
    expect(await store.nonterminalCount()).toBe(1);
    await closeDatabase();

    const reopened = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    const settled = await reopened.get(binding.launchId);
    expect(settled).toEqual({ ...receipt, workerLineageSettled: true });
    expect(projectNodeWorkerSupervisorReceipt(settled!)).toEqual(
      projectNodeWorkerSupervisorReceipt(receipt),
    );
    const cancelled = await reopened.finishCancelled({
      expected: receipt,
      supervisor: receipt.supervisor,
      worker: receipt.worker,
      nowMs: NOW_MS + 1,
    });
    expect(cancelled).toEqual({
      ...settled,
      state: "cancelled",
      errorText: "node worker launch cancelled",
      completedAtMs: NOW_MS + 1,
      updatedAtMs: NOW_MS + 1,
    });
    expect(await reopened.get(binding.launchId)).toEqual(cancelled);
  });

  it.each([
    ["linux-subreaper", "changed plan", "plan_hash = ?", "b".repeat(64)],
    [
      "linux-subreaper",
      "changed owner incarnation",
      "worker_start_time = worker_start_time + ?",
      1,
    ],
    ["owned-anchor", "changed plan", "plan_hash = ?", "b".repeat(64)],
    ["owned-anchor", "changed supervisor", "supervisor_start_time = supervisor_start_time + ?", 1],
    ["owned-anchor", "changed worker PID", "worker_pid = ?", 2_147_483_646],
    ["owned-anchor", "reused worker PID", "worker_start_time = worker_start_time + ?", 1],
    ["owned-anchor", "legacy mode", "cleanup_mode = ?", "process-group"],
  ] as const)("refuses %s completion with %s", async (cleanupMode, reason, assignment, value) => {
    const { database, store, binding } = await runningAnchor(cleanupMode);
    const table = reason === "legacy mode" ? "node_worker_launch_cleanup" : "node_worker_launches";
    database
      .prepare(`UPDATE ${table} SET ${assignment} WHERE launch_id = ?`)
      .run(value, binding.launchId);
    const record =
      cleanupMode === "linux-subreaper"
        ? recordNodeWorkerDescendantsReaped
        : recordNodeWorkerLineageSettled;
    const field =
      cleanupMode === "linux-subreaper" ? "workerDescendantsReaped" : "workerLineageSettled";
    expect(record(binding)).toBe(false);
    expect((await store.get(binding.launchId))?.[field]).toBe(false);
    expect(await store.nonterminalCount()).toBe(1);
  });

  it("keeps missing cleanup ownership unknown and prunes facts only with their launch", async () => {
    const { database, store, binding, receipt } = await runningAnchor();
    insertLaunch(database, "released-running", "running");
    const legacy = (await store.get("released-running"))!;
    expect(recordNodeWorkerLineageSettled(await store.cleanupBinding(legacy))).toBe(false);
    expect(recordNodeWorkerLineageSettled(binding)).toBe(true);
    await store.finish({
      ...binding,
      worker: receipt.worker,
      state: "interrupted",
      errorText: "worker stopped",
      nowMs: NOW_MS,
    });
    expect(await store.pruneExpiredTerminal({ nowMs: NOW_MS + DAY_MS - 1 })).toBe(0);
    expect((await store.get(binding.launchId))?.workerLineageSettled).toBe(true);
    expect(await store.pruneExpiredTerminal({ nowMs: NOW_MS + DAY_MS })).toBe(1);
    expect(
      database.prepare("SELECT count(*) AS count FROM node_worker_launch_cleanup").get(),
    ).toEqual({ count: 0 });
    expect(await store.nonterminalCount()).toBe(1);
  });

  it("refuses a completion write after the launch has become terminal", async () => {
    const { store, binding, receipt } = await runningAnchor();
    await store.finish({
      ...binding,
      worker: receipt.worker,
      state: "interrupted",
      errorText: "worker stopped",
    });
    expect(recordNodeWorkerLineageSettled(binding)).toBe(false);
    expect((await store.get(binding.launchId))?.workerLineageSettled).toBe(false);
    await expect(store.cleanupBinding(binding)).rejects.toThrow("no longer owns its launch");
  });
});
