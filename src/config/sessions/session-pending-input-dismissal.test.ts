import { realpathSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
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
    first: await stage("first-cancelled", "cancelled"),
    second: await stage("second-cancelled", "cancelled"),
    rows,
    states,
    dismiss: (inputIds: readonly string[], sessionId = target.sessionId) =>
      dismissRetiredSessionPendingInputs({ ...target, sessionId }, inputIds, assertCurrent),
  };
}

let f: Fixture;
it.aroundEach(async (run) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    f = await createFixture(openOpenClawAgentDatabase({ agentId: target.agentId }));
    try {
      await run();
    } finally {
      f.receipts.forEach((receipt) => receipt.finish("cancelled"));
      await Promise.all(f.receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
});

it("tombstones retired inputs in the database worker and keeps their rows and content", async () => {
  const hostSql = observeHostDataSql();
  try {
    expect(await f.dismiss([f.first, f.cancelled])).toEqual({
      kind: "dismissed",
      inputIds: [f.first, f.cancelled],
      runIds: ["first-cancelled", "cancelled"],
      missingIds: [],
    });
    expect(hostSql.queries).toEqual([]);
  } finally {
    hostSql.restore();
  }
  const rows = f.rows();
  expect(Object.keys(rows).toSorted()).toEqual(
    [f.queued, f.interrupted, f.cancelled, f.first, f.second].toSorted(),
  );
  for (const [id, runId] of [
    [f.first, "first-cancelled"],
    [f.cancelled, "cancelled"],
  ] as const) {
    expect(rows[id]).toEqual({
      state: "cancelled",
      message: { ...message(runId), display: false },
    });
  }
  expect(rows[f.queued]?.state).toBe("queued");
  expect(rows[f.second]?.state).toBe("cancelled");
  expect(rows[f.interrupted]).toEqual({ state: "interrupted", message: message("interrupted") });
});

it("repeats a dismissal idempotently and reports ids that are no longer retained", async () => {
  await f.dismiss([f.cancelled]);
  const after = f.rows();
  expect(await f.dismiss([f.cancelled, "missing-input", f.second])).toEqual({
    kind: "dismissed",
    inputIds: [f.cancelled, f.second],
    runIds: ["cancelled", "second-cancelled"],
    missingIds: ["missing-input"],
  });
  expect(f.rows()[f.cancelled]).toEqual(after[f.cancelled]);
  expect(f.states()[f.second]).toBe("cancelled");
});

it("leaves legacy interrupted input inert when the sender submits a fresh input", async () => {
  await expect(
    stageSessionPendingInput(target, {
      runId: "interrupted",
      message: message("interrupted"),
      requestFingerprint,
      retryCancelled: true,
      assertCurrent,
    }),
  ).rejects.toThrow("ownership ended");
  const resent = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "fresh-send",
      message: message("fresh-send"),
      requestFingerprint,
      assertCurrent,
    }),
    "Expected a fresh send to acquire custody",
  );
  f.receipts.push(resent);
  expect(resent.inputId).not.toBe(f.interrupted);
  expect(f.states()[f.interrupted]).toBe("interrupted");
  expect(await f.dismiss([resent.inputId])).toEqual({
    kind: "active",
    inputIds: [resent.inputId],
  });
});

it("refuses stale targets without changing retained inputs", async () => {
  const before = f.rows();
  expect(await f.dismiss([f.interrupted], "replaced-session")).toEqual({ kind: "stale" });
  expect(f.rows()).toEqual(before);
});

it("refuses retired rows whose registered owner is still settling", async () => {
  const before = f.rows();
  const owner = {
    inputId: f.first,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    workerDatabasePath: realpathSync(f.database.path),
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    settling: true,
  } as SessionPendingInputOwner;
  registerSessionPendingInputOwner(owner);
  try {
    expect(await f.dismiss([f.first, f.cancelled])).toEqual({
      kind: "active",
      inputIds: [f.first],
    });
    expect(f.rows()).toEqual(before);
  } finally {
    releaseSessionPendingInputOwner(owner);
  }
  expect((await f.dismiss([f.first])).kind).toBe("dismissed");
});
