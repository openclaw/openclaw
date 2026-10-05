import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
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
beforeAll(async () => {
  stateDir = tempDirs.make("openclaw-session-tools-worker-");
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  await advancePlacementFixtureToActive(placements, database, session);
});
afterEach(() => vi.restoreAllMocks());
const claim = (name: string) =>
  placements.claimTurn({
    ...session,
    claimId: `claim-${name}`,
    runId: `run-${name}`,
    owner: { kind: "worker", environmentId: "environment-placement-claim-close", ownerEpoch: 7 },
  });
const operation = (source: WorkerSessionTurnClaim) => ({
  sourceSessionId: source.sessionId,
  sourceClaimId: source.claimId,
  toolCallId: "call",
  requestDigest: "digest",
});
const begin = (
  source: WorkerSessionTurnClaim,
  toolName: "sessions_send" | "sessions_spawn" = "sessions_send",
) => ({
  claim: source,
  toolName,
  toolCallId: "call",
  requestDigest: "digest",
});

it.each([
  { toolName: "sessions_send", lostReply: true },
  { toolName: "sessions_spawn", lostReply: false },
] as const)(
  "seals $toolName admission and drains durable receipts (lost reply: $lostReply)",
  async ({ toolName, lostReply }) => {
    const source = await claim("drain");
    const request = begin(source, toolName);
    const observed = observeHostDataSql();
    try {
      await placements.authorizeWorkerTurnTools(source, [` ${toolName} `]);
      expect(placements.isWorkerTurnToolAuthorized(source, toolName)).toBe(true);
      expect(
        placements.isWorkerTurnToolAuthorized(
          source,
          toolName === "sessions_send" ? "sessions_spawn" : "sessions_send",
        ),
      ).toBe(false);
      expect(await placements.beginWorkerSessionToolOperation(request)).toMatchObject({
        kind: "execute",
        operationSeed: expect.any(String),
      });
      expect(await placements.beginWorkerSessionToolOperation(request)).toEqual({
        kind: "in-progress",
      });
      const closing = placements.closeWorkerTurnToolState(source);
      expect(placements.isWorkerTurnToolAuthorized(source, toolName)).toBe(false);
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
      expect(
        await placements.completeWorkerSessionToolOperation({
          ...operation(source),
          resultJson: '{"status":"ok"}',
        }),
      ).toBe(true);
      verifyCorruption?.();
      await closing;
      await placements.releaseTurn(source);
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
    expect(placements.isWorkerTurnToolAuthorized(source, toolName)).toBe(false);
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_turn_tool_authorities").get(),
    ).toEqual({ count: 0 });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_session_tool_operations").get(),
    ).toEqual({ count: 0 });
  },
);

it("checks live admission at commit and keeps a refused operation replayable", async () => {
  const source = await claim("guard");
  await placements.authorizeWorkerTurnTools(source, ["sessions_send"]);
  let revoked = false;
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          revoked = true;
        }
        admit(request, grant);
      }, attachment),
  );
  await expect(
    placements.beginWorkerSessionToolOperation(begin(source), () => {
      if (revoked) {
        throw new Error("synthetic tool caller revoked");
      }
    }),
  ).rejects.toThrow("synthetic tool caller revoked");
  expect(await placements.beginWorkerSessionToolOperation(begin(source))).toMatchObject({
    kind: "execute",
  });
  await placements.abandonWorkerSessionToolOperation(operation(source));
  await placements.closeWorkerTurnToolState(source);
  await placements.releaseTurn(source);
});

function loseNextAdmissionOutcome() {
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
    (admit, attachment) => {
      const admission = createAdmission(admit, attachment);
      return {
        ...admission,
        get committed() {
          return undefined;
        },
        get settlement() {
          return { kind: "unknown" as const };
        },
      };
    },
  );
}

function corruptReply(matches: (value: Record<string, unknown>) => boolean) {
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
  const source = await claim("unknown");
  await placements.authorizeWorkerTurnTools(source, ["sessions_send"]);
  loseNextAdmissionOutcome();
  const verifyCorruption = corruptReply(
    (value) => isRecord(value.result) && value.result.kind === "execute",
  );
  await expect(placements.beginWorkerSessionToolOperation(begin(source))).rejects.toThrow();
  verifyCorruption();
  expect(placements.isWorkerTurnToolAuthorized(source, "sessions_send")).toBe(false);
  await expect(placements.closeWorkerTurnToolState(source)).rejects.toThrow(
    "restart recovery is required",
  );
  // Fixture recovery settles the exact retained row; production retains it for restart recovery.
  await placements.abandonWorkerSessionToolOperation(operation(source));
  await placements.closeWorkerTurnToolState(source);
  await placements.releaseTurn(source);
});

it("cannot fence a reopened owner's same-byte grant with a delayed uncertain outcome or stale close", async () => {
  const source = await claim("reopened");
  await placements.authorizeWorkerTurnTools(source, ["sessions_send"]);
  const previous = placements;
  const failed = createDeferredCore();
  const deliver = createDeferredCore();
  let originalError: unknown;
  const runOperation = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
    async (context, request, options) => {
      try {
        return await runOperation(context, request, options);
      } catch (error) {
        originalError = error;
        failed.resolve();
        await deliver.promise;
        throw error;
      }
    },
  );
  loseNextAdmissionOutcome();
  const verifyCorruption = corruptReply(
    (value) => isRecord(value.result) && value.result.kind === "execute",
  );
  const pending = previous.beginWorkerSessionToolOperation(begin(source));
  try {
    await failed.promise;
    await closeStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    await placements.recoverWorkerSessionToolOperationsAfterRestart();
    await placements.releaseTurn(source);
    const successor = await claim("reopened");
    expect(successor).toEqual(source);
    await placements.authorizeWorkerTurnTools(successor, ["sessions_send"]);
    const staleClose = previous.closeWorkerTurnToolAdmission(source);
    expect(placements.isWorkerTurnToolAuthorized(successor, "sessions_send")).toBe(true);
    await expect(staleClose).rejects.toThrow();
    await placements.beginWorkerSessionToolOperation(begin(successor));
    deliver.resolve();
    await expect(pending).rejects.toBe(originalError);
    verifyCorruption();
    expect(placements.isWorkerTurnToolAuthorized(successor, "sessions_send")).toBe(true);
    const closing = placements.closeWorkerTurnToolState(successor);
    await placements.completeWorkerSessionToolOperation({
      ...operation(successor),
      resultJson: "{}",
    });
    await closing;
    await placements.releaseTurn(successor);
  } finally {
    deliver.resolve();
    await Promise.allSettled([pending]);
  }
});
