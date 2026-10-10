import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore, type NodeWorkerLaunchClaim } from "./node-worker-launch-store.js";
import * as launchTransport from "./node-worker-launch-transport.js";
import {
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import * as processIdentity from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

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
    async start() {
      await turns.claim({ claim: first, ownerLaunchId: first.launchId, supervisor, nowMs: NOW_MS });
      await launches.markRunning({
        ...first,
        supervisor,
        worker: supervisor,
        cleanupMode: "process-group",
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
  it("returns durable claim and finish receipts within one turn and owner read each", async () => {
    const f = await fixture();
    await f.start();
    await f.finish();
    const database = openOpenClawStateDatabase({ env: f.env });
    const kernel = new NodeWorkerTurnKernel({ database, env: f.env });
    const measure = <T>(operation: () => T): T => {
      const admission = vi
        .spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission")
        .mockImplementation(() => {});
      const reads = trackSqliteStatementExecutions(database.db, ["receipt"], (sql) =>
        sql.startsWith("select ") &&
        (sql.includes('from "node_worker_turns"') || sql.includes('from "node_worker_launches"'))
          ? "receipt"
          : null,
      );
      try {
        const result = operation();
        expect.soft(reads.counts.receipt).toBeLessThanOrEqual(2);
        return result;
      } finally {
        reads.restore();
        admission.mockRestore();
      }
    };
    const claimed = measure(() => kernel.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS + 1 }));
    expect(claimed.action).toBe("start");
    expect(claimed.receipt).toEqual(await f.turns.get(f.next.launchId));
    const finished = measure(() =>
      kernel.finish({
        expected: f.next,
        ...f.owner,
        state: "completed",
        resultJson: "{}",
        nowMs: NOW_MS + 2,
      }),
    );
    expect(finished).toMatchObject({ state: "completed", completedAtMs: NOW_MS + 2 });
    expect(finished).toEqual(await f.turns.get(f.next.launchId));
  });

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
});
