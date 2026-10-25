import { realpathSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";
import { readSessionPendingInputReceiptsInWorker } from "./session-pending-input-receipts.js";
import { dismissRetiredSessionPendingInputs } from "./session-pending-input-withdrawal.js";

const target = {
  agentId: "main",
  sessionKey: "agent:main:pending-input-dismissal",
  sessionId: "dismissal-session",
};
const assertCurrent = () => {};
const requestFingerprint = "d".repeat(64);
const message = (runId: string): PersistedUserTurnMessage => ({
  role: "user",
  content: `Synthetic retained prompt ${runId}`,
  timestamp: 100,
  idempotencyKey: `${runId}:user`,
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(database: OpenClawAgentDatabase) {
  const receipts: SessionPendingInputReceipt[] = [];
  writeSessionEntry(database, target.sessionKey, { sessionId: target.sessionId, updatedAt: 1 });
  const stage = async (runId: string, disposition?: "interrupted" | "cancelled") => {
    const receipt = expectDefined(
      await stageSessionPendingInput(target, {
        runId,
        message: message(runId),
        requestFingerprint,
        assertCurrent,
      }),
      "Expected accepted input custody",
    );
    receipts.push(receipt);
    if (disposition) {
      receipt.finish(disposition);
      await receipt.settled?.();
    }
    return receipt.inputId;
  };
  const rows = () =>
    Object.fromEntries(
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_pending_inputs")
          .select(["input_id", "state", "message_json"])
          .where("session_key", "=", target.sessionKey),
      ).rows.map((row) => [
        row.input_id,
        { state: row.state, message: JSON.parse(row.message_json) as Record<string, unknown> },
      ]),
    );
  const states = () =>
    Object.fromEntries(Object.entries(rows()).map(([id, row]) => [id, row.state]));
  return {
    database,
    receipts,
    queued: await stage("queued"),
    interrupted: await stage("interrupted", "interrupted"),
    cancelled: await stage("cancelled", "cancelled"),
    second: await stage("second-interrupted", "interrupted"),
    rows,
    states,
    receiptsFor: (runIds: string[]) => readSessionPendingInputReceiptsInWorker(target, { runIds }),
    dismiss: (
      inputIds: readonly string[],
      sessionId = target.sessionId,
      current: () => void = assertCurrent,
    ) => dismissRetiredSessionPendingInputs({ ...target, sessionId }, inputIds, current),
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture(openOpenClawAgentDatabase({ agentId: target.agentId }));
    try {
      await run(fixture);
    } finally {
      fixture.receipts.forEach((receipt) => receipt.finish("cancelled"));
      await Promise.all(fixture.receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
}

it("tombstones retired inputs in the database worker and keeps their rows and content", async () => {
  await withFixture(async (f) => {
    const hostSql = observeHostDataSql();
    try {
      expect(await f.dismiss([f.interrupted, f.cancelled])).toEqual({
        kind: "dismissed",
        inputIds: [f.interrupted, f.cancelled],
        runIds: ["interrupted", "cancelled"],
        missingIds: [],
      });
      expect(hostSql.queries).toEqual([]);
    } finally {
      hostSql.restore();
    }
    const rows = f.rows();
    expect(Object.keys(rows).toSorted()).toEqual(
      [f.queued, f.interrupted, f.cancelled, f.second].toSorted(),
    );
    for (const [id, runId] of [
      [f.interrupted, "interrupted"],
      [f.cancelled, "cancelled"],
    ] as const) {
      expect(rows[id]).toEqual({
        state: "cancelled",
        message: { ...message(runId), display: false },
      });
    }
    expect(rows[f.queued]?.state).toBe("queued");
    expect(rows[f.second]?.state).toBe("interrupted");
  });
});

it("keeps a cancelled receipt as the replay fence after dismissal", async () => {
  await withFixture(async (f) => {
    expect(await f.receiptsFor(["interrupted"])).toEqual([
      { runId: "interrupted", state: "pending" },
    ]);
    await f.dismiss([f.interrupted]);
    expect(await f.receiptsFor(["interrupted", "queued"])).toEqual(
      expect.arrayContaining([
        { runId: "interrupted", state: "pending", cancelled: true },
        { runId: "queued", state: "pending" },
      ]),
    );
  });
});

it("repeats a dismissal idempotently and reports ids that are no longer retained", async () => {
  await withFixture(async (f) => {
    await f.dismiss([f.cancelled]);
    const after = f.rows();
    expect(await f.dismiss([f.cancelled, "missing-input", f.second])).toEqual({
      kind: "dismissed",
      inputIds: [f.cancelled, f.second],
      runIds: ["cancelled", "second-interrupted"],
      missingIds: ["missing-input"],
    });
    expect(f.rows()[f.cancelled]).toEqual(after[f.cancelled]);
    expect(f.states()[f.second]).toBe("cancelled");
  });
});

it("refuses queued and stale targets without changing anything", async () => {
  await withFixture(async (f) => {
    const before = f.rows();
    expect(await f.dismiss([f.interrupted, f.queued])).toEqual({
      kind: "active",
      inputIds: [f.queued],
    });
    expect(await f.dismiss([f.interrupted], "replaced-session")).toEqual({ kind: "stale" });
    expect(f.rows()).toEqual(before);
  });
});

it("refuses an interrupted input that a resend has reclaimed", async () => {
  await withFixture(async (f) => {
    const resent = expectDefined(
      await stageSessionPendingInput(target, {
        runId: "interrupted",
        message: message("interrupted"),
        requestFingerprint,
        retryInterrupted: true,
        assertCurrent,
      }),
      "Expected the resend to reclaim interrupted custody",
    );
    f.receipts.push(resent);
    expect(resent.inputId).toBe(f.interrupted);
    expect(f.states()[f.interrupted]).toBe("queued");
    expect(await f.dismiss([f.interrupted])).toEqual({
      kind: "active",
      inputIds: [f.interrupted],
    });
    resent.finish("interrupted");
    await resent.settled?.();
    expect(f.states()[f.interrupted]).toBe("interrupted");
    expect((await f.dismiss([f.interrupted])).kind).toBe("dismissed");
  });
});

it("refuses retired rows whose registered owner is still settling", async () => {
  await withFixture(async (f) => {
    const before = f.rows();
    const owner = {
      inputId: f.interrupted,
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      workerDatabasePath: realpathSync(f.database.path),
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      settling: true,
    } as SessionPendingInputOwner;
    registerSessionPendingInputOwner(owner);
    try {
      expect(await f.dismiss([f.interrupted, f.cancelled])).toEqual({
        kind: "active",
        inputIds: [f.interrupted],
      });
      expect(f.rows()).toEqual(before);
    } finally {
      releaseSessionPendingInputOwner(owner);
    }
    expect((await f.dismiss([f.interrupted])).kind).toBe("dismissed");
  });
});

it("rolls back dismissal when session write authority is revoked at commit", async () => {
  await withFixture(async (f) => {
    const before = f.rows();
    let current = true;
    const admitted = probe.admission(admission, (request, grant, callback) => {
      if (request.stage === "commit") {
        current = false;
      }
      return callback(request, grant);
    });
    try {
      await expect(
        f.dismiss([f.interrupted, f.cancelled], target.sessionId, () => {
          if (!current) {
            throw new Error("Dismissal authority revoked");
          }
        }),
      ).rejects.toThrow("Dismissal authority revoked");
      expect(current).toBe(false);
      expect(f.rows()).toEqual(before);
    } finally {
      admitted.mockRestore();
    }
  });
});
