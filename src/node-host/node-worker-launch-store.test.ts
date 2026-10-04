import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
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

describe("node worker launch admitted schema", () => {
  function kernelFixture() {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-launch-schema-") };
    const opened = openOpenClawStateDatabase({ env });
    const kernel = new NodeWorkerLaunchKernel({ database: opened, env });
    const admission = vi
      .spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => {});
    kernel.get("schema-probe");
    insertLaunch({ database: opened.db, launchId: "schema-launch", state: "pending" });
    return { ...opened, opened, env, kernel, admission };
  }

  it("shares admitted facts across warm launch joins without suppressing operation freshness", () => {
    const { db, kernel, admission } = kernelFixture();
    try {
      const pending = kernel.get("schema-launch")!;
      const measure = (receipt: typeof pending) => {
        // Warm outside the transaction after lazy DDL invalidates transactional facts.
        expect(kernel.get(receipt.launchId)).toEqual(receipt);
        expect(readNodeWorkerLaunchReceipt(db, receipt.launchId)).toEqual(receipt);
        const reads = trackSqliteStatementExecutions(
          db,
          ["schema", "dataVersion", "launch"],
          (sql) => {
            if (/sqlite_(?:schema|master)/iu.test(sql)) {
              return "schema";
            }
            if (/^PRAGMA data_version$/iu.test(sql)) {
              return "dataVersion";
            }
            return sql.startsWith("select ") && sql.includes('from "node_worker_launches"')
              ? "launch"
              : null;
          },
        );
        try {
          for (let index = 0; index < 3; index += 1) {
            expect(kernel.get(receipt.launchId)).toEqual(receipt);
            expect(kernel.listNonterminal()).toEqual([receipt]);
            expect(readNodeWorkerLaunchReceipt(db, receipt.launchId)).toEqual(receipt);
          }
          // Each launch read probes freshness once, not once per optional companion join.
          expect(reads.counts).toEqual({ schema: 0, dataVersion: 9, launch: 9 });
          expect(reads.rowCounts.launch).toBe(9);
        } finally {
          reads.restore();
        }
      };
      measure(pending);
      const running = kernel.markRunning({
        ...pending,
        worker: pending.supervisor,
        cleanupMode: "linux-subreaper",
        nowMs: NOW_MS,
      });
      expect(running).toMatchObject({
        workerCleanupMode: "linux-subreaper",
        workerDescendantsReaped: false,
        workerLineageSettled: false,
      });
      measure(running);
    } finally {
      admission.mockRestore();
    }
  });

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

  it("observes foreign companion commits after the current snapshot without inventing certificates", () => {
    const { db, path, kernel, admission } = kernelFixture();
    // Native connection bypasses in-process schema publications, like a separate worker.
    const foreign = new (requireNodeSqlite().DatabaseSync)(path);
    try {
      const pending = kernel.get("schema-launch")!;
      const legacy = kernel.markRunning({
        ...pending,
        worker: pending.supervisor,
        cleanupMode: "owned-anchor",
        nowMs: NOW_MS,
      });
      expect(legacy.workerDescendantsReaped).toBeUndefined();
      db.exec("BEGIN");
      try {
        expect(readNodeWorkerLaunchReceipt(db, legacy.launchId)).toEqual(legacy);
        foreign.exec(
          extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "node_worker_launch_process_scopes"),
        );
        foreign
          .prepare(
            "INSERT INTO node_worker_launch_process_scopes (launch_id, scope_kind, descendants_reaped) VALUES (?, 'linux-subreaper', NULL)",
          )
          .run(legacy.launchId);
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
      foreign
        .prepare(
          "UPDATE node_worker_launch_process_scopes SET descendants_reaped = 1 WHERE launch_id = ?",
        )
        .run(legacy.launchId);
      expect(kernel.listNonterminal()).toEqual([{ ...current, workerDescendantsReaped: true }]);
      foreign
        .prepare("DELETE FROM node_worker_launch_process_scopes WHERE launch_id = ?")
        .run(legacy.launchId);
      expect(kernel.get(legacy.launchId)).toEqual(legacy);
    } finally {
      foreign.close();
      admission.mockRestore();
    }
  });
});

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

  it.each([false, true])(
    "preserves lazy container identity across reopen (container: %s)",
    async (withContainer) => {
      const { database, env, store } = await fixture();
      expect(hasContainerIdentityTable(database)).toBe(false);
      const initialSchemaVersion = database.prepare("PRAGMA user_version").get();
      const launchId = withContainer ? "container-launch" : "bare-launch";
      const { planHash, supervisor } = await claimLaunch(store, launchId);
      const container = withContainer
        ? ({
            engine: "docker",
            containerId: "a".repeat(64),
            engineTarget: "b".repeat(64),
          } as const)
        : undefined;

      const receipt = await store.markRunning({
        launchId,
        planHash,
        supervisor,
        worker: supervisor,
        cleanupMode: withContainer ? null : "process-group",
        ...(container ? { container } : {}),
        nowMs: NOW_MS,
      });

      expect(hasContainerIdentityTable(database)).toBe(withContainer);
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
        expect(hasContainerIdentityTable(openOpenClawStateDatabase({ env }).db)).toBe(false);
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
  async function runningAnchor(cleanupMode: "owned-anchor" | "linux-subreaper" = "owned-anchor") {
    const { database, env, store } = await fixture();
    const launchId = "anchor-launch";
    const { planHash, supervisor } = await claimLaunch(store, launchId);
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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
    ["linux-subreaper", "changed plan", "node_worker_launches", "plan_hash = ?", "b".repeat(64)],
    [
      "linux-subreaper",
      "changed owner incarnation",
      "node_worker_launches",
      "worker_start_time = worker_start_time + ?",
      1,
    ],
    ["owned-anchor", "changed plan", "node_worker_launches", "plan_hash = ?", "b".repeat(64)],
    [
      "owned-anchor",
      "changed supervisor",
      "node_worker_launches",
      "supervisor_start_time = supervisor_start_time + ?",
      1,
    ],
    ["owned-anchor", "changed worker PID", "node_worker_launches", "worker_pid = ?", 2_147_483_646],
    [
      "owned-anchor",
      "reused worker PID",
      "node_worker_launches",
      "worker_start_time = worker_start_time + ?",
      1,
    ],
    [
      "owned-anchor",
      "legacy mode",
      "node_worker_launch_cleanup",
      "cleanup_mode = ?",
      "process-group",
    ],
  ] as const)(
    "refuses %s completion with %s",
    async (cleanupMode, _reason, table, assignment, value) => {
      const { database, store, binding } = await runningAnchor(cleanupMode);
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
    },
  );

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
