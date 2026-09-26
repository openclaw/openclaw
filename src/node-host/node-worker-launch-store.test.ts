import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OpenClawStateExternalOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import { recordNodeWorkerLineageSettled } from "./node-worker-lineage-completion.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { projectNodeWorkerSupervisorReceipt } from "./node-worker-supervisor-contract.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { writeNodeWorkerFixture } from "./node-worker-supervisor.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 10 * DAY_MS;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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

function insertLaunch(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>["db"];
  launchId: string;
  state: "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  completedAtMs?: number;
  planHash?: string;
}) {
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  const terminal =
    params.state === "completed" ||
    params.state === "failed" ||
    params.state === "interrupted" ||
    params.state === "cancelled";
  const completedAtMs = terminal ? (params.completedAtMs ?? NOW_MS) : null;
  params.database
    .prepare(
      `INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'gateway-1', 'environment-1', 'session-1', 3, 4, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      params.launchId,
      params.planHash ?? "a".repeat(64),
      params.state,
      processIdentity.pid,
      processIdentity.startTime,
      params.state === "running" ? processIdentity.pid : null,
      params.state === "running" ? processIdentity.startTime : null,
      params.state === "completed" ? '{"status":"completed"}' : null,
      terminal && params.state !== "completed" ? `worker ${params.state}` : null,
      completedAtMs,
      completedAtMs ?? 1,
    );
}

function hasTerminalExpiryIndex(
  database: ReturnType<typeof openOpenClawStateDatabase>["db"],
): boolean {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get("idx_node_worker_launches_terminal_completed"),
  );
}

function launchIds(database: ReturnType<typeof openOpenClawStateDatabase>["db"]): string[] {
  return (
    database
      .prepare("SELECT launch_id FROM node_worker_launches ORDER BY launch_id")
      .all() as Array<{
      launch_id: string;
    }>
  ).map((row) => row.launch_id);
}

describe("node worker launch store pruning", () => {
  it("lazily repairs released journals without rewriting old receipts or advancing the schema", async () => {
    const { database, env, store } = await fixture();
    insertLaunch({ database, launchId: "released-worker", state: "running" });
    const releasedReceipt = await store.get("released-worker");
    const versionBefore = database.prepare("PRAGMA user_version").get();
    expect(hasTerminalExpiryIndex(database)).toBe(true);
    database.exec("DROP INDEX idx_node_worker_launches_terminal_completed");
    expect(hasTerminalExpiryIndex(database)).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const reopenedStore = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    expect(await reopenedStore.get("released-worker")).toEqual(releasedReceipt);
    const reopened = openOpenClawStateDatabase({ env }).db;

    expect(hasTerminalExpiryIndex(reopened)).toBe(true);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      reopened
        .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
        .get("node_worker_launch_cleanup"),
    ).toBeUndefined();
    const launchSql = reopened
      .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
      .get("node_worker_launches")?.sql;
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
    expect(
      reopened.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get("node_worker_launches")
        ?.sql,
    ).toBe(launchSql);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    insertLaunch({ database: reopened, launchId: "older-writer", state: "running" });
    expect(await reopenedStore.get("older-writer")).toMatchObject({
      workerCleanupMode: null,
      workerLineageSettled: false,
    });
  });

  it("uses the terminal expiry index for the ordered pruning query", async () => {
    const { database } = await fixture();
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT launch_id
         FROM node_worker_launches
         WHERE state IN ('completed', 'failed', 'interrupted', 'cancelled')
           AND completed_at_ms <= ?
         ORDER BY completed_at_ms ASC, launch_id ASC
         LIMIT ?`,
      )
      .all(NOW_MS - DAY_MS, 2) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_node_worker_launches_terminal_completed",
    );
  });

  it("prunes only the oldest expired terminal receipts in bounded batches", async () => {
    const { database, store } = await fixture();
    insertLaunch({ database, launchId: "old-completed", state: "completed", completedAtMs: 1 });
    insertLaunch({ database, launchId: "old-failed", state: "failed", completedAtMs: 2 });
    insertLaunch({ database, launchId: "old-cancelled", state: "cancelled", completedAtMs: 3 });
    insertLaunch({
      database,
      launchId: "recent-completed",
      state: "completed",
      completedAtMs: NOW_MS - 1_000,
    });
    insertLaunch({ database, launchId: "pending", state: "pending" });
    insertLaunch({ database, launchId: "running", state: "pending" });
    const supervisor = requireNodeWorkerProcessIdentity(process.pid);
    const container = {
      engine: "docker",
      containerId: "a".repeat(64),
      engineTarget: "b".repeat(64),
    } as const;
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
    const containerLaunchIds = () =>
      (
        database
          .prepare("SELECT launch_id FROM node_worker_launch_containers ORDER BY launch_id")
          .all() as Array<{ launch_id: string }>
      ).map((row) => row.launch_id);

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
    insertLaunch({
      database,
      launchId: "expired-after-restart",
      state: "completed",
      completedAtMs: 1,
    });
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot: workerFixture.bundleRoot,
      env: workerFixture.env,
    });

    await supervisor.initialize();

    expect(await store.get("expired-after-restart")).toBeUndefined();
    await supervisor.close();
  });

  it("keeps the exact replay fence while a new claim prunes unrelated receipts", async () => {
    const { database, store } = await fixture();
    const planHash = "b".repeat(64);
    insertLaunch({
      database,
      launchId: "replayed-launch",
      state: "completed",
      completedAtMs: 1,
      planHash,
    });
    insertLaunch({ database, launchId: "stale-launch", state: "completed", completedAtMs: 2 });
    const supervisor = requireNodeWorkerProcessIdentity(process.pid);

    expect(
      await store.claim(
        {
          launchId: "replayed-launch",
          planHash,
          gatewayNamespace: "gateway-1",
          environmentId: "environment-1",
          sessionId: "session-1",
          ownerEpoch: 3,
          placementGeneration: 4,
          runId: "run-1",
        },
        supervisor,
        2,
        NOW_MS,
      ),
    ).toMatchObject({ action: "replay", receipt: { state: "completed" } });
    expect(launchIds(database)).toEqual(["replayed-launch"]);
  });
});

async function claimLaunch(store: NodeWorkerLaunchStore, launchId: string) {
  const supervisor = requireNodeWorkerProcessIdentity(process.pid);
  const planHash = "a".repeat(64);
  const result = await store.claim(
    {
      launchId,
      planHash,
      gatewayNamespace: "gateway-1",
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
    },
    supervisor,
    2,
    NOW_MS,
  );
  expect(result.action).toBe("start");
  return { planHash, supervisor };
}

describe("node worker terminal ownership", () => {
  it.each(["finish", "cancel"] as const)(
    "keeps the physical reservation when %s comes from a stale process owner",
    async (operation) => {
      const { database, env, store } = await fixture();
      insertLaunch({ database, launchId: "owned-launch", state: "running" });
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
      const kernel = new NodeWorkerLaunchKernel({
        database: openOpenClawStateDatabase({ env }),
        env,
      });
      const admission = vi
        .spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission")
        .mockImplementation(() => {});
      const reads = trackSqliteStatementExecutions(database, ["launch"], (sql) =>
        sql.startsWith("select ") && sql.includes('from "node_worker_launches"') ? "launch" : null,
      );
      let terminal: ReturnType<NodeWorkerLaunchKernel["finishCancelled"]>;
      try {
        terminal =
          operation === "cancel"
            ? kernel.finishCancelled({ expected: running, ...running })
            : kernel.finish({
                launchId: running.launchId,
                planHash: running.planHash,
                supervisor: running.supervisor,
                worker: running.worker,
                state: "failed",
                errorText: "worker failed",
              });
        expect.soft(reads.counts.launch).toBeLessThanOrEqual(1);
        expect.soft(reads.rowCounts.launch).toBe(1);
      } finally {
        reads.restore();
        admission.mockRestore();
      }
      expect(terminal?.state).toBe(operation === "cancel" ? "cancelled" : "failed");
      expect(await store.get(running.launchId)).toEqual(terminal);
      expect(await store.nonterminalCount()).toBe(0);
    },
  );
});

describe("node worker launch store container identity", () => {
  function hasContainerIdentityTable(
    database: Awaited<ReturnType<typeof fixture>>["database"],
  ): boolean {
    return Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("node_worker_launch_containers"),
    );
  }

  it("keeps the container companion table absent for existing bare-worker journals", async () => {
    const { database, env, store } = await fixture();
    expect(hasContainerIdentityTable(database)).toBe(false);
    const { planHash, supervisor } = await claimLaunch(store, "bare-launch");

    const receipt = await store.markRunning({
      launchId: "bare-launch",
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode: "process-group",
      nowMs: NOW_MS,
    });

    expect(hasContainerIdentityTable(database)).toBe(false);
    expect(Object.hasOwn(receipt, "container")).toBe(false);
    expect(await store.get("bare-launch")).toEqual(receipt);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    expect(
      await new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env })).get("bare-launch"),
    ).toEqual(receipt);
    expect(hasContainerIdentityTable(openOpenClawStateDatabase({ env }).db)).toBe(false);
  });

  it("lazily persists container identity across reopen without advancing the schema", async () => {
    const { database, env, store } = await fixture();
    expect(hasContainerIdentityTable(database)).toBe(false);
    const initialSchemaVersion = database.prepare("PRAGMA user_version").get();
    const { planHash, supervisor } = await claimLaunch(store, "container-launch");
    const container = {
      engine: "docker",
      containerId: "a".repeat(64),
      engineTarget: "b".repeat(64),
    } as const;

    const receipt = await store.markRunning({
      launchId: "container-launch",
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode: null,
      container,
      nowMs: NOW_MS,
    });

    expect(receipt.container).toEqual(container);
    expect(hasContainerIdentityTable(database)).toBe(true);
    expect(database.prepare("PRAGMA user_version").get()).toEqual(initialSchemaVersion);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const reopened = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    expect(await reopened.get("container-launch")).toEqual(receipt);
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
    expect(await reopened.get("container-launch")).toEqual(completed);
  });

  it.each([
    ["missing container id", JSON.stringify({ engine: "docker", engineTarget: "b".repeat(64) })],
    ["missing engine target", JSON.stringify({ engine: "docker", containerId: "a".repeat(64) })],
    [
      "unknown engine",
      JSON.stringify({
        engine: "runc",
        containerId: "a".repeat(64),
        engineTarget: "b".repeat(64),
      }),
    ],
    [
      "ambiguous container id prefix",
      JSON.stringify({
        engine: "docker",
        containerId: "a".repeat(12),
        engineTarget: "b".repeat(64),
      }),
    ],
    [
      "invalid container id",
      JSON.stringify({
        engine: "docker",
        containerId: "container-123",
        engineTarget: "b".repeat(64),
      }),
    ],
    [
      "invalid engine target",
      JSON.stringify({
        engine: "docker",
        containerId: "a".repeat(64),
        engineTarget: "b".repeat(12),
      }),
    ],
    [
      "unexpected identity field",
      JSON.stringify({
        engine: "docker",
        containerId: "a".repeat(64),
        engineTarget: "b".repeat(64),
        extra: true,
      }),
    ],
  ])("fails closed when a persisted container identity has %s", async (_reason, malformed) => {
    const { database, store } = await fixture();
    const { planHash, supervisor } = await claimLaunch(store, "corrupt-container-launch");
    await store.markRunning({
      launchId: "corrupt-container-launch",
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode: null,
      container: { engine: "docker", containerId: "a".repeat(64), engineTarget: "b".repeat(64) },
      nowMs: NOW_MS,
    });
    database
      .prepare("UPDATE node_worker_launch_containers SET container_json = ? WHERE launch_id = ?")
      .run(malformed, "corrupt-container-launch");

    await expect(store.listNonterminal()).rejects.toThrow(
      /node worker container (identity|id|engine target)/u,
    );
  });
});

describe("node worker cleanup journal", () => {
  async function runningAnchor() {
    const { database, env, store } = await fixture();
    const launchId = "anchor-launch";
    const { planHash, supervisor } = await claimLaunch(store, launchId);
    const binding = await store.cleanupBinding({ launchId, planHash, supervisor });
    const receipt = await store.markRunning({
      launchId,
      planHash,
      supervisor,
      worker: supervisor,
      cleanupMode: "owned-anchor",
      nowMs: NOW_MS,
    });
    return { database, env, store, binding, receipt };
  }

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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    fs.unlinkSync(binding.databasePath);
    let failure: unknown;

    try {
      recordNodeWorkerLineageSettled(binding);
    } catch (error) {
      failure = error;
    }

    expect(fs.existsSync(binding.databasePath)).toBe(false);
    expect(failure).toMatchObject({ code: "ENOENT" });
  });

  it("persists positive lineage completion on the exact database without releasing its slot or changing the wire receipt", async () => {
    const { env, store, binding, receipt } = await runningAnchor();
    expect(binding.databasePath).toBe(openOpenClawStateDatabase({ env }).path);
    expect(receipt.workerCleanupMode).toBe("owned-anchor");
    expect(receipt.workerLineageSettled).toBe(false);
    expect(recordNodeWorkerLineageSettled(binding)).toBe(true);
    expect(recordNodeWorkerLineageSettled(binding)).toBe(true);
    expect(await store.nonterminalCount()).toBe(1);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

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
    ["changed plan", "node_worker_launches", "plan_hash = ?", "b".repeat(64)],
    [
      "changed supervisor",
      "node_worker_launches",
      "supervisor_start_time = supervisor_start_time + ?",
      1,
    ],
    ["changed worker PID", "node_worker_launches", "worker_pid = ?", 2_147_483_646],
    ["reused worker PID", "node_worker_launches", "worker_start_time = worker_start_time + ?", 1],
    ["legacy mode", "node_worker_launch_cleanup", "cleanup_mode = ?", "process-group"],
  ] as const)("refuses lineage completion with %s", async (_reason, table, assignment, value) => {
    const { database, store, binding } = await runningAnchor();
    database
      .prepare(`UPDATE ${table} SET ${assignment} WHERE launch_id = ?`)
      .run(value, binding.launchId);
    expect(recordNodeWorkerLineageSettled(binding)).toBe(false);
    expect((await store.get(binding.launchId))?.workerLineageSettled).toBe(false);
    expect(await store.nonterminalCount()).toBe(1);
  });

  it("keeps missing cleanup ownership unknown and prunes facts only with their launch", async () => {
    const { database, store, binding, receipt } = await runningAnchor();
    insertLaunch({ database, launchId: "released-running", state: "running" });
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
