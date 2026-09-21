import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerContainerIdentity,
  type NodeWorkerLaunchClaim,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import * as launchTransport from "./node-worker-launch-transport.js";
import {
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import * as processIdentity from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 10 * DAY_MS;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

async function fixture(
  supervisor: NodeWorkerProcessIdentity = requireNodeWorkerProcessIdentity(process.pid),
  env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-turn-store-") },
) {
  const journal = new NodeWorkerJournalWorker({ env });
  const launches = new NodeWorkerLaunchStore(journal);
  const turns = new NodeWorkerTurnStore(journal);
  const first: NodeWorkerLaunchClaim = {
    launchId: "first-turn",
    planHash: "a".repeat(64),
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 3,
    placementGeneration: 4,
    runId: "first-run",
  };
  const next: NodeWorkerLaunchClaim = {
    ...first,
    launchId: "second-turn",
    planHash: "b".repeat(64),
    runId: "second-run",
  };
  const owner = { ownerLaunchId: first.launchId, supervisor, worker: supervisor };
  await launches.claim(first, supervisor, 1, NOW_MS);
  return {
    env,
    journal,
    launches,
    turns,
    supervisor,
    first,
    next,
    owner,
    async start(container?: NodeWorkerContainerIdentity) {
      await turns.claim({ claim: first, ownerLaunchId: first.launchId, supervisor, nowMs: NOW_MS });
      await launches.markRunning({
        ...first,
        supervisor,
        worker: supervisor,
        cleanupMode: container ? null : "process-group",
        container,
        nowMs: NOW_MS,
      });
    },
    finish(claim = first) {
      return turns.finish({
        ...owner,
        expected: claim,
        state: "completed",
        resultJson: JSON.stringify({ turnId: claim.launchId }),
        nowMs: NOW_MS,
      });
    },
  };
}

describe("node worker turn journal", () => {
  it("reads and replays durable receipts after supervisor shutdown without restarting recovery", async () => {
    const unexpected = () => {
      throw new Error("Process work is outside this receipt-only fixture");
    };
    vi.spyOn(processIdentity, "requireNodeWorkerProcessIdentity").mockImplementation(unexpected);
    vi.spyOn(processIdentity, "inspectNodeWorkerProcessIdentity").mockImplementation(unexpected);
    vi.spyOn(launchTransport, "prepareNodeWorkerLaunchTransport").mockImplementation(unexpected);
    const f = await fixture({ pid: 17, startTime: 23 });
    const supervisor = createNodeWorkerSupervisor({ env: f.env, capacity: 1 });
    try {
      await f.start();
      const completed = await f.finish();
      expect(completed).toMatchObject({ state: "completed" });
      await f.launches.finish({
        ...f.owner,
        launchId: f.first.launchId,
        planHash: f.first.planHash,
        state: "completed",
        resultJson: JSON.stringify({ turnId: f.first.launchId }),
        nowMs: NOW_MS,
      });
      await supervisor.close();
      expect(await supervisor.status(f.first.launchId)).toEqual(completed);
      expect(await supervisor.cancel(f.first)).toEqual(completed);
      expect(await supervisor.status("absent-turn")).toBeUndefined();
      await supervisor.close();
      expect(await supervisor.status(f.first.launchId)).toEqual(completed);
      await f.journal.drain();
      expect(await f.turns.get(f.first.launchId)).toEqual(completed);
      await expect(f.finish()).rejects.toThrow("admission is closed");
    } finally {
      await supervisor.close();
      vi.restoreAllMocks();
    }
  });

  it("keeps completed turn receipts independent of the physical slot and later turns across reopen", async () => {
    expect(isMainThread).toBe(true);
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-turn-store-") };
    const parentSql = observeHostDataSql(env);
    try {
      const f = await fixture({ pid: 17, startTime: 23 }, env);
      expect(
        await f.launches.cleanupBinding({
          launchId: f.first.launchId,
          planHash: f.first.planHash,
          supervisor: f.supervisor,
        }),
      ).toMatchObject({ launchId: f.first.launchId, supervisor: f.supervisor });
      expect(
        await f.turns.claim({
          claim: f.first,
          ownerLaunchId: f.first.launchId,
          supervisor: f.supervisor,
          nowMs: NOW_MS,
        }),
      ).toMatchObject({ action: "start", receipt: { state: "pending", worker: null } });
      await f.start();
      expect(await f.turns.get(f.first.launchId)).toMatchObject({
        state: "running",
        worker: f.supervisor,
      });
      const completed = await f.finish();

      expect((await f.launches.get(f.first.launchId))?.state).toBe("running");
      expect(await f.launches.nonterminalCount()).toBe(1);
      expect(await f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS })).toMatchObject({
        action: "start",
        receipt: { launchId: f.next.launchId, ownerLaunchId: f.first.launchId, state: "running" },
      });
      expect(await f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS })).toEqual({
        action: "replay",
        receipt: completed,
      });
      expect(
        await f.turns.finish({
          ...f.owner,
          expected: f.first,
          state: "failed",
          errorText: "late failure",
        }),
      ).toEqual(completed);
      expect((await f.turns.get(f.next.launchId))?.state).toBe("running");
      expect(
        await f.launches.claim({ ...f.next, launchId: "another-worker" }, f.supervisor, 1, NOW_MS),
      ).toMatchObject({
        action: "at-capacity",
      });
      const terminal = await f.launches.finish({
        ...f.first,
        supervisor: f.supervisor,
        worker: f.supervisor,
        state: "completed",
        resultJson: "{}",
        nowMs: NOW_MS + 1,
      });
      expect(terminal.state).toBe("completed");
      expect(await f.turns.get(f.first.launchId)).toEqual(completed);
      expect(await f.turns.get(f.next.launchId)).toMatchObject({ state: "interrupted" });
      expect(parentSql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      await f.journal.drain();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      const reopenedJournal = new NodeWorkerJournalWorker({ env: f.env });
      expect(await new NodeWorkerLaunchStore(reopenedJournal).get(f.first.launchId)).toEqual(
        terminal,
      );
      expect(await new NodeWorkerTurnStore(reopenedJournal).get(f.first.launchId)).toEqual(
        completed,
      );
      expect(await new NodeWorkerTurnStore(reopenedJournal).get(f.next.launchId)).toMatchObject({
        state: "interrupted",
      });
      expect(parentSql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      parentSql.restore();
    }
  });

  it.each([
    ["gateway namespace", { gatewayNamespace: "gateway-2" }],
    ["environment", { environmentId: "environment-2" }],
    ["session", { sessionId: "session-2" }],
    ["owner epoch", { ownerEpoch: 4 }],
    ["placement generation", { placementGeneration: 5 }],
  ] satisfies Array<[string, Partial<NodeWorkerLaunchClaim>]>)(
    "rejects a turn bound to another %s",
    async (_label, patch) => {
      const f = await fixture();
      await f.start();
      await expect(f.turns.claim({ claim: { ...f.next, ...patch }, ...f.owner })).rejects.toThrow(
        "live physical owner",
      );
      expect(await f.turns.get(f.next.launchId)).toBeUndefined();
    },
  );

  it("requires the exact supervisor and worker even when the placement matches", async () => {
    const f = await fixture();
    await f.start();
    for (const field of ["supervisor", "worker"] as const) {
      await expect(
        f.turns.claim({
          claim: f.next,
          ...f.owner,
          [field]: { ...f.supervisor, startTime: f.supervisor.startTime + 1 },
        }),
      ).rejects.toThrow("live physical owner");
    }
    await expect(
      f.turns.claim({ claim: f.next, ownerLaunchId: f.first.launchId, supervisor: f.supervisor }),
    ).rejects.toThrow("live physical owner");
  });

  it("rejects conflicting retries and serializes different turns across store handles", async () => {
    const f = await fixture();
    await f.start();
    await f.turns.claim({ claim: f.first, ...f.owner });
    const other = new NodeWorkerTurnStore(new NodeWorkerJournalWorker({ env: f.env }));
    expect((await other.claim({ claim: f.first, ...f.owner })).action).toBe("replay");
    for (const patch of [
      { planHash: f.next.planHash },
      { runId: f.next.runId },
      { sessionId: f.next.sessionId + "-other" },
    ]) {
      await expect(other.claim({ claim: { ...f.first, ...patch }, ...f.owner })).rejects.toThrow(
        "different plan or owner",
      );
    }
    await expect(
      other.claim({ claim: f.first, ...f.owner, ownerLaunchId: "different-worker" }),
    ).rejects.toThrow("different plan or owner");
    await expect(other.claim({ claim: f.next, ...f.owner })).rejects.toThrow(
      "UNIQUE constraint failed",
    );
    await f.finish();
    expect((await other.claim({ claim: f.next, ...f.owner })).action).toBe("start");
  });

  it("rejects stale result writers and immutable identity mismatches", async () => {
    const f = await fixture();
    await f.start();
    await f.turns.claim({ claim: f.first, ...f.owner });
    expect(
      await f.turns.finish({
        ...f.owner,
        expected: { ...f.first, runId: "wrong-run" },
        state: "completed",
        resultJson: "{}",
      }),
    ).toBeUndefined();
    expect(await f.turns.getMatching({ ...f.first, ownerEpoch: 4 })).toBeUndefined();
    expect(
      await f.turns.finish({
        ...f.owner,
        expected: f.first,
        worker: { ...f.supervisor, startTime: f.supervisor.startTime + 1 },
        state: "completed",
        resultJson: "{}",
      }),
    ).toMatchObject({ state: "running" });
    expect((await f.turns.get(f.first.launchId))?.state).toBe("running");
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] satisfies NodeWorkerTerminalState[])(
    "closes unfinished turns atomically when their physical owner becomes %s",
    async (state) => {
      const f = await fixture();
      await f.start();
      await f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS });
      const completed = await f.finish();
      await f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS + 2 });
      await f.launches.finish({
        ...f.first,
        supervisor: f.supervisor,
        worker: f.supervisor,
        state,
        ...(state === "completed"
          ? { resultJson: "{}" }
          : { errorText: "physical worker stopped" }),
        nowMs: NOW_MS + 1,
      });
      const database = openOpenClawStateDatabase({ env: f.env }).db;
      expect(
        database
          .prepare("SELECT state, completed_at_ms FROM node_worker_turns WHERE turn_id = ?")
          .get(f.next.launchId),
      ).toEqual({
        state: state === "completed" ? "interrupted" : state,
        completed_at_ms: NOW_MS + 2,
      });
      expect(await f.turns.get(f.first.launchId)).toEqual(completed);
      expect(await f.launches.nonterminalCount()).toBe(0);
    },
  );

  it("keeps bare physical cleanup inert and cancels a pending first turn once admitted", async () => {
    const untracked = await fixture();
    await untracked.launches.finishCancelled({
      expected: untracked.first,
      supervisor: untracked.supervisor,
      worker: null,
    });
    expect(
      openOpenClawStateDatabase({ env: untracked.env })
        .db.prepare("SELECT name FROM sqlite_schema WHERE name = 'node_worker_turns'")
        .get(),
    ).toBeUndefined();
    const f = await fixture();
    await f.turns.claim({
      claim: f.first,
      ownerLaunchId: f.first.launchId,
      supervisor: f.supervisor,
    });
    await f.launches.finishCancelled({ expected: f.first, supervisor: f.supervisor, worker: null });
    expect(await f.turns.get(f.first.launchId)).toMatchObject({
      state: "cancelled",
      errorText: "node worker launch cancelled",
    });
  });

  it("prunes bounded old turn receipts without releasing the warm owner or losing the current replay", async () => {
    const f = await fixture();
    await f.start();
    await f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS });
    await f.finish();
    const database = openOpenClawStateDatabase({ env: f.env }).db;
    const insert = database.prepare(`
      INSERT INTO node_worker_turns (turn_id, owner_launch_id, plan_hash, run_id, state,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, 'historical-run', 'completed', '{}', NULL, 1, 1, 1)
    `);
    for (let index = 0; index < 258; index += 1) {
      insert.run(`old-${index}`, f.first.launchId, f.first.planHash);
    }
    expect(
      (await f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS + DAY_MS + 1 })).action,
    ).toBe("replay");
    expect(database.prepare("SELECT count(*) AS count FROM node_worker_turns").get()).toEqual({
      count: 3,
    });
    expect((await f.turns.get(f.first.launchId))?.state).toBe("completed");
    await f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS + DAY_MS + 1 });
    expect(database.prepare("SELECT turn_id FROM node_worker_turns").all()).toEqual([
      { turn_id: f.next.launchId },
    ]);
    expect((await f.launches.get(f.first.launchId))?.state).toBe("running");
    expect(await f.launches.nonterminalCount()).toBe(1);
    await f.finish(f.next);
    await expect(
      f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS + DAY_MS + 1 }),
    ).rejects.toThrow("live physical owner");
  });

  it("lets the predecessor preserve live capacity, finish and prune the owner, then reopens the candidate", async () => {
    const f = await fixture();
    const container = {
      engine: "docker",
      containerId: "c".repeat(64),
      engineTarget: "d".repeat(64),
    } as const;
    await f.start(container);
    await f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS });
    const completed = await f.finish();
    await f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS });
    const opened = openOpenClawStateDatabase({ env: f.env });
    const initialVersion = opened.db.prepare("PRAGMA user_version").get();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "CREATE TABLE IF NOT EXISTS node_worker_turns (",
    );
    const endMarker = "\n  WHERE state = 'running';";
    const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) + endMarker.length;
    const predecessorSchema =
      OPENCLAW_STATE_SCHEMA_SQL.slice(0, start) + OPENCLAW_STATE_SCHEMA_SQL.slice(end);
    const predecessor = new DatabaseSync(opened.path);
    try {
      predecessor.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        assertSqliteSchemaContains(predecessor, "predecessor shared state", predecessorSchema, {
          ...OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
          allowedMissingTables:
            OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingTables?.filter(
              (table) => table !== "node_worker_turns",
            ),
        }),
      ).not.toThrow();
      expect(predecessor.prepare("PRAGMA user_version").get()).toEqual(initialVersion);
      expect(
        predecessor
          .prepare(
            "SELECT count(*) AS count FROM node_worker_launches WHERE state IN ('pending', 'running')",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        predecessor
          .prepare("SELECT container_json FROM node_worker_launch_containers WHERE launch_id = ?")
          .get(f.first.launchId),
      ).toEqual({ container_json: JSON.stringify(container) });
      predecessor
        .prepare("DELETE FROM node_worker_launches WHERE completed_at_ms <= ?")
        .run(NOW_MS + DAY_MS);
      expect(predecessor.prepare("SELECT count(*) AS count FROM node_worker_turns").get()).toEqual({
        count: 2,
      });
      predecessor
        .prepare(
          "UPDATE node_worker_launches SET state = 'interrupted', error_text = 'predecessor cleanup', completed_at_ms = ?, updated_at_ms = ? WHERE launch_id = ?",
        )
        .run(NOW_MS + 1, NOW_MS + 1, f.first.launchId);
    } finally {
      predecessor.close();
    }

    const candidate = new NodeWorkerTurnStore(new NodeWorkerJournalWorker({ env: f.env }));
    expect(await candidate.get(f.first.launchId)).toEqual(completed);
    expect(await candidate.get(f.next.launchId)).toMatchObject({
      state: "interrupted",
      errorText: "predecessor cleanup",
    });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const pruningPredecessor = new DatabaseSync(opened.path);
    try {
      pruningPredecessor.exec("PRAGMA foreign_keys = ON");
      pruningPredecessor
        .prepare(
          "DELETE FROM node_worker_launch_containers WHERE launch_id IN (SELECT launch_id FROM node_worker_launches WHERE completed_at_ms <= ?)",
        )
        .run(NOW_MS + DAY_MS);
      pruningPredecessor
        .prepare("DELETE FROM node_worker_launches WHERE completed_at_ms <= ?")
        .run(NOW_MS + DAY_MS);
      expect(
        pruningPredecessor.prepare("SELECT count(*) AS count FROM node_worker_turns").get(),
      ).toEqual({ count: 0 });
    } finally {
      pruningPredecessor.close();
    }
    expect(
      await new NodeWorkerTurnStore(new NodeWorkerJournalWorker({ env: f.env })).get(
        f.first.launchId,
      ),
    ).toBeUndefined();
  });
});
