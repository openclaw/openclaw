import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

let placements: WorkerSessionPlacementStore;
let database: OpenClawStateDatabase;
let stateDir: string;
const session = {
  sessionId: "tools-worker-session",
  agentId: "main",
  sessionKey: "agent:main:tools-worker-session",
};
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
function openStore() {
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
}
beforeAll(async () => {
  stateDir = tempDirs.make("openclaw-session-tools-worker-");
  openStore();
  await advancePlacementFixtureToActive(placements, database, session);
});
afterEach(() => vi.restoreAllMocks());
async function claim(name: string, toolName: "sessions_send" | "sessions_spawn" = "sessions_send") {
  const source = await placements.claimTurn({
    ...session,
    claimId: `claim-${name}`,
    runId: `run-${name}`,
    owner: { kind: "worker", environmentId: "environment-placement-claim-close", ownerEpoch: 7 },
  });
  const store = placements;
  const call = { toolCallId: "call", requestDigest: "digest" };
  const request = { claim: source, toolName, ...call };
  const operation = { sourceSessionId: source.sessionId, sourceClaimId: source.claimId, ...call };
  return {
    source,
    request,
    authorize: (names: string[] = [toolName]) => store.authorizeWorkerTurnTools(source, names),
    begin: (assertCurrent?: () => void) =>
      store.beginWorkerSessionToolOperation(request, assertCurrent),
    authorized: (tool = toolName) => store.isWorkerTurnToolAuthorized(source, tool),
    complete: (resultJson = "{}") =>
      store.completeWorkerSessionToolOperation({ ...operation, resultJson }),
    close: () => store.closeWorkerTurnToolState(source),
    release: () => store.releaseTurn(source),
    abandon: async () => {
      await store.abandonWorkerSessionToolOperation(operation);
      await store.closeWorkerTurnToolState(source);
      await store.releaseTurn(source);
    },
  };
}

it.each([
  { toolName: "sessions_send", lostReply: true },
  { toolName: "sessions_spawn", lostReply: false },
] as const)(
  "seals $toolName admission and drains durable receipts (lost reply: $lostReply)",
  async ({ toolName, lostReply }) => {
    const turn = await claim("drain", toolName);
    const observed = observeHostDataSql();
    const { request } = turn;
    try {
      await turn.authorize([` ${toolName} `]);
      expect(turn.authorized()).toBe(true);
      expect(
        turn.authorized(toolName === "sessions_send" ? "sessions_spawn" : "sessions_send"),
      ).toBe(false);
      expect(await turn.begin()).toMatchObject({
        kind: "execute",
        operationSeed: expect.any(String),
      });
      expect(await turn.begin()).toEqual({ kind: "in-progress" });
      const closing = turn.close();
      expect(turn.authorized()).toBe(false);
      expect(
        await placements.beginWorkerSessionToolOperation({
          ...request,
          toolCallId: "late",
          requestDigest: "late-digest",
        }),
      ).toEqual({ kind: "unauthorized" });
      const verifyCorruption = lostReply
        ? corruptReply((value) => value.changed === true && value.toolNames === undefined)
        : undefined;
      expect(await turn.complete('{"status":"ok"}')).toBe(true);
      verifyCorruption?.();
      await closing;
      await turn.release();
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
    expect(turn.authorized()).toBe(false);
    for (const table of ["worker_turn_tool_authorities", "worker_session_tool_operations"]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
  },
);

it("checks live admission at commit and keeps a refused operation replayable", async () => {
  const turn = await claim("guard");
  await turn.authorize();
  let revoked = false;
  const createAdmission = admission.createSqliteWorkerOperationAdmission;
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          revoked = true;
        }
        admit(request, grant);
      }, attachment),
  );
  await expect(
    turn.begin(() => {
      if (revoked) {
        throw new Error("synthetic tool caller revoked");
      }
    }),
  ).rejects.toThrow("synthetic tool caller revoked");
  expect(await turn.begin()).toMatchObject({ kind: "execute" });
  await turn.abandon();
});

function loseNextAdmissionOutcome() {
  vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementationOnce(() => {});
  const createAdmission = admission.createSqliteWorkerOperationAdmission;
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) => {
      const original = createAdmission(admit, attachment);
      return {
        ...original,
        committed: undefined,
        settlement: { kind: "unknown" as const },
      };
    },
  );
}

function corruptReply(
  matches: (value: Record<string, unknown>) => boolean = (value) =>
    isRecord(value.result) && value.result.kind === "execute",
) {
  const receive = brokerReply.receiveSqliteWorkerReply;
  let corrupted = false;
  vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
    if (
      !corrupted &&
      slot.current?.request.type === "execute" &&
      reply.ok &&
      !reply.transfer &&
      !reply.input
    ) {
      const value: unknown = deserialize(reply.value);
      if (isRecord(value) && matches(value)) {
        corrupted = true;
        return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
      }
    }
    return receive(slot, reply, owner);
  });
  return () => expect(corrupted).toBe(true);
}

it("reports an uncertain admission to teardown instead of waiting for an unowned operation", async () => {
  const turn = await claim("unknown");
  await turn.authorize();
  loseNextAdmissionOutcome();
  const verifyCorruption = corruptReply();
  await expect(turn.begin()).rejects.toThrow();
  verifyCorruption();
  expect(turn.authorized()).toBe(false);
  await expect(turn.close()).rejects.toThrow("restart recovery is required");
  // Fixture recovery settles the exact retained row; production retains it for restart recovery.
  await turn.abandon();
});

it("cannot fence a reopened owner's same-byte grant with a delayed uncertain outcome or stale close", async () => {
  const turn = await claim("reopened");
  await turn.authorize();
  const { source } = turn;
  const previous = placements;
  const failed = createDeferredCore<unknown>();
  const deliver = createDeferredCore();
  const runOperation = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
    async (context, request, options) => {
      try {
        return await runOperation(context, request, options);
      } catch (error) {
        failed.resolve(error);
        await deliver.promise;
        throw error;
      }
    },
  );
  loseNextAdmissionOutcome();
  const verifyCorruption = corruptReply();
  const pending = turn.begin();
  try {
    const originalError = await failed.promise;
    await closeStateDatabaseForTest();
    openStore();
    await placements.recoverWorkerSessionToolOperationsAfterRestart();
    await placements.releaseTurn(source);
    const successor = await claim("reopened");
    await successor.authorize();
    expect(successor.source).toEqual(source);
    const staleClose = previous.closeWorkerTurnToolAdmission(source);
    expect(successor.authorized()).toBe(true);
    await expect(staleClose).rejects.toThrow();
    await successor.begin();
    deliver.resolve();
    await expect(pending).rejects.toBe(originalError);
    verifyCorruption();
    expect(successor.authorized()).toBe(true);
    const closing = successor.close();
    await successor.complete();
    await closing;
    await successor.release();
  } finally {
    deliver.resolve();
    await Promise.allSettled([pending]);
  }
});
