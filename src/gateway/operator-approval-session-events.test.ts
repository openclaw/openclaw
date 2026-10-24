import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorkerStore from "../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager, type ExecApprovalRecord } from "./exec-approval-manager.js";
import { installTestApprovalClock } from "./exec-approval-manager.test-support.js";
import { createOperatorApprovalSessionEventRuntime } from "./operator-approval-session-events.js";
import {
  createClient,
  createPendingRecord,
  createTerminalRecord,
  PARENT_SESSION_KEY,
  SOURCE_SESSION_KEY,
} from "./operator-approval-session-events.test-support.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";
import * as operatorApprovalStore from "./operator-approval-store.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";

const SIBLING_SESSION_KEY = "agent:main:parent:sibling";
const tempDirs: string[] = [];
const subscriptions: Array<() => void> = [];
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-events-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createRuntime(
  params: Omit<
    Parameters<typeof createOperatorApprovalSessionEventRuntime>[0],
    "sessionMessageSubscribers" | "broadcastToConnIds"
  > & { now?: () => number },
) {
  const { now = Date.now, ...runtimeParams } = params;
  vi.spyOn(Date, "now").mockImplementation(now);
  const subscribers = createSessionMessageSubscriberRegistry();
  const broadcastToConnIds = vi.fn<GatewayBroadcastToConnIdsFn>();
  const runtime = createOperatorApprovalSessionEventRuntime({
    ...runtimeParams,
    sessionMessageSubscribers: subscribers,
    broadcastToConnIds,
  });
  return {
    broadcastToConnIds,
    runtime: {
      ...runtime,
      replay: async (...args: Parameters<typeof runtime.replay>) => {
        const prepared = await runtime.replay(...args);
        subscriptions.push(prepared.release);
        return prepared;
      },
    },
    subscribers,
  };
}

async function insertPendingApproval(params: {
  databaseOptions: OpenClawStateDatabaseOptions;
  id: string;
  audienceSessionKeys?: string[];
  createdAtMs?: number;
  expiresAtMs?: number;
  reviewerDeviceIds?: string[];
}): Promise<OperatorApprovalRecord> {
  const record = createPendingRecord({
    audienceSessionKeys: [SOURCE_SESSION_KEY],
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...params,
  });
  const approval: NewOperatorApproval = {
    id: record.id,
    kind: record.kind,
    presentation: record.presentation,
    requester: record.requester,
    reviewerDeviceIds: params.reviewerDeviceIds ?? record.reviewerDeviceIds,
    source: record.source,
    audienceSessionKeys: record.audienceSessionKeys,
    runtimeEpoch: record.runtimeEpoch,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
  const inserted = await insertOperatorApproval({
    approval,
    databaseOptions: params.databaseOptions,
  });
  if (inserted.outcome !== "inserted") {
    throw new Error(`expected approval '${params.id}' to be inserted`);
  }
  return inserted.record;
}

function createReviewer(connId = "reviewer", deviceId = "reviewer-device") {
  return createClient({ connId, scopes: ["operator.approvals"], deviceId });
}

function holdReplay() {
  const selected = createDeferredCore();
  const reply = createDeferredCore();
  const prepare = operatorApprovalStore.prepareOperatorApprovalReplay;
  const spy = vi
    .spyOn(operatorApprovalStore, "prepareOperatorApprovalReplay")
    .mockImplementationOnce(async (params) => {
      const records = await prepare(params);
      selected.resolve();
      await reply.promise;
      return records;
    });
  return { selected, reply, spy };
}

describe("operator approval session events", () => {
  afterEach(async () => {
    for (const unsubscribe of subscriptions.splice(0)) {
      unsubscribe();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(["pending", "terminal"] as const)(
    "publishes only valid %s state to opted-in, authorized audiences",
    (phase) => {
      const clients = [
        createClient({ connId: "source-admin", scopes: ["operator.admin"] }),
        createReviewer("source-device", "source-reviewer"),
        createClient({ connId: "source-no-device", scopes: ["operator.approvals"] }),
        createReviewer("source-unrelated-device", "unrelated-device"),
        createReviewer("source-requester-device", "requester-device"),
        createClient({
          connId: "source-no-scope",
          scopes: ["operator.read"],
          deviceId: "unprivileged-device",
        }),
        createClient({ connId: "source-not-opted-in", scopes: ["operator.admin"] }),
        createClient({
          connId: "source-invalidated",
          scopes: ["operator.admin"],
          invalidated: true,
        }),
        createReviewer("parent-device", "parent-reviewer"),
        createClient({ connId: "sibling-admin", scopes: ["operator.admin"] }),
      ];
      const { broadcastToConnIds, runtime, subscribers } = createRuntime({
        clients,
        controlUiBasePath: phase === "pending" ? "/operator/" : undefined,
      });
      for (const connId of [
        "source-admin",
        "source-device",
        "source-no-device",
        "source-unrelated-device",
        "source-requester-device",
        "source-no-scope",
        "source-invalidated",
      ]) {
        subscribers.subscribe(connId, SOURCE_SESSION_KEY, { includeApprovals: true });
      }
      subscribers.subscribe("source-not-opted-in", SOURCE_SESSION_KEY);
      subscribers.subscribe("parent-device", PARENT_SESSION_KEY, { includeApprovals: true });
      subscribers.subscribe("sibling-admin", SIBLING_SESSION_KEY, { includeApprovals: true });

      const pending = createPendingRecord({
        reviewerDeviceIds: ["source-reviewer", "parent-reviewer"],
      });
      const terminal = createTerminalRecord(pending);
      runtime.publish({ phase: "terminal", record: pending });
      runtime.publish({ phase: "pending", record: terminal });
      expect(broadcastToConnIds).not.toHaveBeenCalled();
      const record = phase === "pending" ? pending : terminal;
      runtime.publish({ phase, record });

      expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
      expect(broadcastToConnIds).toHaveBeenNthCalledWith(
        1,
        "session.approval",
        {
          sessionKey: SOURCE_SESSION_KEY,
          sourceSessionKey: SOURCE_SESSION_KEY,
          phase,
          updatedAtMs: phase === "pending" ? 1_000 : 2_000,
          approval: {
            id: record.id,
            status: phase === "pending" ? "pending" : "denied",
            presentation: record.presentation,
            urlPath: `${phase === "pending" ? "/operator" : ""}/approve/approval%3Achild%2Frequest%3F1`,
            createdAtMs: 1_000,
            expiresAtMs: 10_000,
            ...(phase === "terminal"
              ? { decision: "deny", reason: "user", resolvedAtMs: 2_000 }
              : {}),
          },
        },
        new Set(["source-admin", "source-device"]),
      );
      expect(broadcastToConnIds).toHaveBeenNthCalledWith(
        2,
        "session.approval",
        expect.objectContaining({
          sessionKey: PARENT_SESSION_KEY,
          sourceSessionKey: SOURCE_SESSION_KEY,
          phase,
        }),
        new Set(["parent-device"]),
      );

      const payloads = broadcastToConnIds.mock.calls.map((call) => call[1]);
      expect(payloads).not.toContainEqual(
        expect.objectContaining({ sessionKey: SIBLING_SESSION_KEY }),
      );
      const serialized = JSON.stringify(payloads);
      expect(serialized).not.toContain("requester-device");
      expect(serialized).not.toContain("requester-client");
      expect(serialized).not.toContain("private-session-id");
      expect(serialized).not.toContain("private-run-id");
      expect(serialized).not.toContain("private-tool-call-id");
      expect(serialized).not.toContain("private-runtime-epoch");
    },
  );

  it.each([
    ["global", ["agent:main:global"], ["pending", "terminal"]],
    ["child", ["agent:work:child", "agent:work:parent"], ["pending"]],
  ] as const)(
    "publishes the canonical audience source key for %s",
    (sourceSessionKey, audience, phases) => {
      const client = createClient({ connId: "admin", scopes: ["operator.admin"] });
      const { broadcastToConnIds, runtime, subscribers } = createRuntime({ clients: [client] });
      subscribers.subscribe("admin", audience[0], { includeApprovals: true });
      const pending = createPendingRecord({ sourceSessionKey, audienceSessionKeys: [...audience] });
      for (const phase of phases) {
        runtime.publish({
          phase,
          record: phase === "pending" ? pending : createTerminalRecord(pending),
        });
      }
      expect(broadcastToConnIds.mock.calls).toEqual(
        phases.map((phase) => [
          "session.approval",
          expect.objectContaining({
            sessionKey: audience[0],
            sourceSessionKey: audience[0],
            phase,
          }),
          new Set(["admin"]),
        ]),
      );
    },
  );

  it.each(["padded binding", "exact audience"] as const)(
    "replays the authorized pending set for %s",
    async (variant) => {
      const padded = variant === "padded binding";
      const databaseOptions = createDatabaseOptions();
      const audience = padded ? SOURCE_SESSION_KEY : PARENT_SESSION_KEY;
      const records = padded
        ? [{ id: "padded-reviewer", audienceSessionKeys: [SOURCE_SESSION_KEY] }]
        : [
            {
              id: "source-and-parent",
              audienceSessionKeys: [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
            },
            { id: "parent-only", audienceSessionKeys: [PARENT_SESSION_KEY] },
            { id: "sibling-only", audienceSessionKeys: [SIBLING_SESSION_KEY] },
            { id: "already-resolved", audienceSessionKeys: [PARENT_SESSION_KEY] },
          ];
      for (const [index, record] of records.entries()) {
        await insertPendingApproval({
          databaseOptions,
          ...record,
          createdAtMs: 1_000 + index,
        });
      }
      if (padded) {
        const { db } = openOpenClawStateDatabase(databaseOptions);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "operator_approvals">>(db)
            .updateTable("operator_approvals")
            .set({ reviewer_device_ids_json: JSON.stringify([" reviewer-device "]) })
            .where("approval_id", "=", "padded-reviewer"),
        );
      } else {
        expect(
          await resolveOperatorApproval({
            id: "already-resolved",
            decision: "deny",
            resolver: { kind: "device", id: "reviewer-device" },
            nowMs: 2_000,
            databaseOptions,
          }),
        ).toMatchObject({ outcome: "resolved" });
      }
      const reviewerClient = createReviewer();
      const other = createReviewer("other", "unrelated-device");
      const nowMs = padded ? 2_000 : 5_000;
      const { runtime } = createRuntime({
        clients: padded ? [reviewerClient, other] : [],
        controlUiBasePath: padded ? undefined : "/operator",
        now: () => nowMs,
      });
      const { replay } = await runtime.replay(audience, reviewerClient);
      if (padded) {
        expect(replay.approvals.map(({ id }) => id)).toEqual(["padded-reviewer"]);
        expect(
          await operatorApprovalStore.getOperatorApprovalDetailed({
            id: "padded-reviewer",
            nowMs,
            databaseOptions,
          }),
        ).toMatchObject({ outcome: "found", record: { reviewerDeviceIds: [" reviewer-device "] } });
      } else {
        expect(replay).toEqual({
          sessionKey: PARENT_SESSION_KEY,
          updatedAtMs: 5_000,
          truncated: false,
          approvals: [
            {
              id: "source-and-parent",
              status: "pending",
              sourceSessionKey: SOURCE_SESSION_KEY,
              presentation: createPendingRecord({ id: "source-and-parent" }).presentation,
              urlPath: "/operator/approve/source-and-parent",
              createdAtMs: 1_000,
              expiresAtMs: 10_000,
            },
            {
              id: "parent-only",
              status: "pending",
              sourceSessionKey: PARENT_SESSION_KEY,
              presentation: createPendingRecord({ id: "parent-only" }).presentation,
              urlPath: "/operator/approve/parent-only",
              createdAtMs: 1_001,
              expiresAtMs: 10_000,
            },
          ],
        });
      }
      expect((await runtime.replay(audience, other)).replay).toEqual({
        sessionKey: audience,
        updatedAtMs: nowMs,
        truncated: false,
        approvals: [],
      });
    },
  );

  it("replays committed approvals while an unrelated shared-state writer is held", async ({
    signal,
  }) => {
    const databaseOptions = createDatabaseOptions();
    await insertPendingApproval({
      databaseOptions,
      id: "committed-before-writer",
    });
    const reviewer = createClient({ connId: "reviewer", scopes: ["operator.admin"] });
    const { runtime } = createRuntime({ clients: [reviewer], now: () => 5_000 });
    // Warm read admission before holding a real transaction on the same physical database.
    (await runtime.replay(SOURCE_SESSION_KEY, reviewer)).release();
    const held = createDeferredCore();
    let releaseWriter: (() => void) | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- call below preserves the intercepted port receiver.
    const onMessage = MessagePort.prototype.on;
    // Hold delivery, not the grant callback: admission deliberately refuses an ungranted request.
    const probe = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
      this: MessagePort,
      event,
      listener,
    ) {
      if (event !== "message") {
        return onMessage.call(this, event, listener);
      }
      return onMessage.call(this, event, (message: unknown) => {
        if (
          isRecord(message) &&
          message.stage === "transaction" &&
          message.decision instanceof SharedArrayBuffer &&
          !releaseWriter
        ) {
          releaseWriter = () => listener(message);
          held.resolve();
        } else {
          listener(message);
        }
      });
    });
    const writerContext = captureOpenClawStateWorkerContext(databaseOptions);
    // Use the physical writer independently of the approval API's logical FIFO.
    const writing = stateWorkerStore.runOpenClawStateWorkerOperation(
      writerContext,
      (scope) =>
        scope.execute({ type: "operatorApprovals.prepareReplay", input: { nowMs: 5_000 } }),
      {
        createAdmission: createSqliteWorkerWriteAdmission(writerContext.admission.assertCurrent, [
          writerContext.admission.databasePath,
        ]),
      },
    );
    let replay: ReturnType<typeof runtime.replay> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(held.promise, writing, "Writer did not reach its transaction"),
        signal,
      );
      replay = runtime.replay(SOURCE_SESSION_KEY, reviewer);
      const prepared = await withinTest(replay, signal);
      expect(prepared.replay.approvals.map(({ id }) => id)).toEqual(["committed-before-writer"]);
      expect(prepared.isCurrent()).toBe(true);
    } finally {
      releaseWriter?.();
      probe.mockRestore();
      await Promise.allSettled([writing, replay]);
    }
  });

  it("uses one store admission and read per independent no-expiry replay", async () => {
    const databaseOptions = createDatabaseOptions();
    const audienceSessionKeys = Array.from(
      { length: 64 },
      (_, index) => `agent:main:replay-${index}`,
    );
    await insertPendingApproval({
      databaseOptions,
      id: "replay-admission",
      audienceSessionKeys,
    });
    const reviewer = createClient({ connId: "reviewer", scopes: ["operator.admin"] });
    const { runtime } = createRuntime({ clients: [reviewer], now: () => 5_000 });
    (await runtime.replay(audienceSessionKeys[0]!, reviewer)).release();
    const admissions = vi.spyOn(stateWorkerStore, "runOpenClawStateWorkerOperation");
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const measured: { replays: number; admissions: number; reads: number }[] = [];
    for (const count of [1, 12, 64]) {
      admissions.mockClear();
      reads.mockClear();
      const prepared = await Promise.all(
        audienceSessionKeys.slice(0, count).map((key) => runtime.replay(key, reviewer)),
      );
      expect(prepared.map(({ replay }) => replay.approvals.map(({ id }) => id))).toEqual(
        Array.from({ length: count }, () => ["replay-admission"]),
      );
      measured.push({
        replays: count,
        admissions: admissions.mock.calls.length,
        reads: reads.mock.calls.length,
      });
      for (const replay of prepared) {
        replay.release();
      }
    }
    expect(measured).toEqual([
      { replays: 1, admissions: 1, reads: 1 },
      { replays: 12, admissions: 12, reads: 12 },
      { replays: 64, admissions: 64, reads: 64 },
    ]);
  });

  it("shares only matching audiences and reviewers while checking each waiting client", async () => {
    const databaseOptions = createDatabaseOptions();
    await insertPendingApproval({
      databaseOptions,
      id: "shared-replay",
    });
    const clients = ["revoked", "retained", "other-reviewer"].map((connId) =>
      createClient({
        connId,
        scopes: ["operator.approvals"],
        deviceId: connId === "other-reviewer" ? "other-device" : "reviewer-device",
      }),
    );
    const { runtime } = createRuntime({ clients, now: () => 5_000 });
    const { selected, reply, spy: delayed } = holdReplay();
    const revoked = runtime.replay(SOURCE_SESSION_KEY, clients[0]!);
    const rejected = expect(revoked).rejects.toThrow("replay authority is no longer current");
    const retained = runtime.replay(SOURCE_SESSION_KEY, clients[1]!);
    const otherReviewer = runtime.replay(SOURCE_SESSION_KEY, clients[2]!);
    const otherSession = runtime.replay(SIBLING_SESSION_KEY, clients[1]!);
    try {
      await selected.promise;
      clients[0]!.connect.scopes = [];
      reply.resolve();
      await rejected;
      const retainedReplay = await retained;
      const otherReviewerReplay = await otherReviewer;
      const otherSessionReplay = await otherSession;
      expect(retainedReplay.replay.approvals.map(({ id }) => id)).toEqual(["shared-replay"]);
      expect(otherReviewerReplay.replay.approvals).toEqual([]);
      expect(otherSessionReplay.replay.approvals).toEqual([]);
      expect(delayed.mock.calls.length).toBe(3);
      const secondReplay = await runtime.replay(SOURCE_SESSION_KEY, clients[1]!);
      retainedReplay.release();
      retainedReplay.release();
      expect(retainedReplay.isCurrent()).toBe(false);
      // Completed work is not cached: storage truth can change without a lifecycle publication.
      const terminal = await resolveOperatorApproval({
        id: "shared-replay",
        decision: "deny",
        resolver: { kind: "device", id: "reviewer-device" },
        nowMs: 5_001,
        databaseOptions,
      });
      expect((await runtime.replay(SOURCE_SESSION_KEY, clients[1]!)).replay.approvals).toEqual([]);
      if (terminal.outcome !== "resolved") {
        throw new Error("Expected terminal approval decision");
      }
      runtime.publish({ phase: "terminal", record: terminal.record });
      expect(secondReplay.isCurrent()).toBe(false);
      expect(otherReviewerReplay.isCurrent()).toBe(true);
      expect(otherSessionReplay.isCurrent()).toBe(true);
    } finally {
      reply.resolve();
      await Promise.allSettled([revoked, retained, otherReviewer, otherSession]);
    }
  });

  it("invalidates pending replay when a decision precedes the worker reply", async () => {
    const databaseOptions = createDatabaseOptions();
    const pending = await insertPendingApproval({
      databaseOptions,
      id: "terminal-during-replay",
    });
    const reviewerClient = createReviewer();
    const { runtime, subscribers, broadcastToConnIds } = createRuntime({
      clients: [reviewerClient],
      now: () => 5_000,
    });
    subscribers.subscribe("reviewer", SOURCE_SESSION_KEY, { includeApprovals: true });
    const { selected, reply, spy: delayedReply } = holdReplay();
    const preparation = runtime.replay(SOURCE_SESSION_KEY, reviewerClient);
    try {
      await selected.promise;
      const terminal = await resolveOperatorApproval({
        id: pending.id,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer-device" },
        nowMs: 5_001,
        databaseOptions,
      });
      if (terminal.outcome !== "resolved") {
        throw new Error("Expected terminal approval decision");
      }
      runtime.publish({ phase: "terminal", record: terminal.record });
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "session.approval",
        expect.objectContaining({ phase: "terminal" }),
        new Set(["reviewer"]),
      );
      reply.resolve();
      expect((await preparation).isCurrent()).toBe(false);
      const prepared = await runtime.replay(SOURCE_SESSION_KEY, reviewerClient);
      expect(prepared.isCurrent()).toBe(true);
      expect(prepared.replay.approvals).toEqual([]);
      expect(delayedReply.mock.calls.length).toBe(2);
    } finally {
      reply.resolve();
      await preparation;
      delayedReply.mockRestore();
    }
  });

  it.each([false, true])(
    "publishes committed expiry to ancestor recipients (requester revoked=%s)",
    async (revoked) => {
      const databaseOptions = createDatabaseOptions();
      const id = revoked ? "expired-during-revocation" : "expired-child-approval";
      const deviceId = revoked ? "reviewer-device" : "parent-device";
      await insertPendingApproval({
        databaseOptions,
        id,
        audienceSessionKeys: [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
        expiresAtMs: 4_000,
        reviewerDeviceIds: [deviceId],
      });
      const observer = createReviewer("observer", deviceId);
      const requester = revoked ? createReviewer("requester", deviceId) : observer;
      const { runtime, subscribers, broadcastToConnIds } = createRuntime({
        clients: revoked ? [requester, observer] : [observer],
        now: () => 5_000,
      });
      subscribers.subscribe("observer", PARENT_SESSION_KEY, { includeApprovals: true });
      const held = revoked ? holdReplay() : undefined;
      const preparation = runtime.replay(SOURCE_SESSION_KEY, requester);
      const rejected = revoked
        ? expect(preparation).rejects.toThrow("replay authority is no longer current")
        : undefined;
      try {
        if (revoked) {
          await held?.selected.promise;
          requester.connect.scopes = [];
          held?.reply.resolve();
          await rejected;
        } else {
          expect((await preparation).replay).toEqual({
            sessionKey: SOURCE_SESSION_KEY,
            updatedAtMs: 5_000,
            approvals: [],
            truncated: false,
          });
        }
        expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "session.approval",
          expect.objectContaining({
            sessionKey: PARENT_SESSION_KEY,
            sourceSessionKey: SOURCE_SESSION_KEY,
            phase: "terminal",
            updatedAtMs: 5_000,
            approval: expect.objectContaining({
              id,
              status: "expired",
              reason: "timeout",
              resolvedAtMs: 5_000,
            }),
          }),
          new Set(["observer"]),
        );
      } finally {
        held?.reply.resolve();
        await preparation.catch(() => {});
        held?.spy.mockRestore();
      }
    },
  );

  it("publishes expiry once when replay reconciliation joins a held manager mutation", async () => {
    const databaseOptions = createDatabaseOptions();
    const reviewerClient = createReviewer();
    const managerHolder: { current?: ExecApprovalManager } = {};
    const reconciling = createDeferredCore();
    let replayAtMs = Date.now();
    const { runtime, subscribers, broadcastToConnIds } = createRuntime({
      clients: [reviewerClient],
      now: () => replayAtMs,
      reconcileTerminal: (record) => {
        reconciling.resolve();
        return managerHolder.current?.reconcileDurableTerminal(record) ?? false;
      },
    });
    const manager = new ExecApprovalManager({
      scheduler: createTestGatewayScheduler(),
      persistence: { runtimeEpoch: "replay-mutation-race", databaseOptions },
      onLifecycle: runtime.publish,
    });
    managerHolder.current = manager;
    const record = manager.create(
      { command: "printf expiry", sessionKey: SOURCE_SESSION_KEY },
      60_000,
      "expiry-race",
    );
    const { decision } = await manager.register(record, 60_000);
    subscribers.subscribe("reviewer", SOURCE_SESSION_KEY, { includeApprovals: true });
    replayAtMs = record.expiresAtMs;
    const { selected: sweepCommitted, reply: releaseSweep, spy: delayedSweep } = holdReplay();
    const mutationCommitted = createDeferredCore();
    const releaseMutation = createDeferredCore();
    const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
    const delayedMutation = vi
      .spyOn(operatorApprovalStore, "forceDenyOperatorApproval")
      .mockImplementationOnce(async (params) => {
        const result = await forceDeny(params);
        mutationCommitted.resolve();
        await releaseMutation.promise;
        return result;
      });
    const replay = runtime.replay(SOURCE_SESSION_KEY, reviewerClient);
    let expiry: Promise<boolean> | undefined;
    try {
      await sweepCommitted.promise;
      expiry = manager.expire(record.id);
      await mutationCommitted.promise;
      releaseSweep.resolve();
      await reconciling.promise;
      releaseMutation.resolve();
      await expiry;
      const prepared = await replay;
      expect(prepared.isCurrent()).toBe(true);
      expect(prepared.replay.approvals).toEqual([]);
      await expect(decision).resolves.toBeNull();
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "session.approval",
        expect.objectContaining({
          phase: "terminal",
          approval: expect.objectContaining({
            id: record.id,
            status: "expired",
            reason: "timeout",
          }),
        }),
        new Set(["reviewer"]),
      );
    } finally {
      releaseSweep.resolve();
      releaseMutation.resolve();
      await Promise.allSettled([replay, expiry]);
      await manager.drain();
      delayedSweep.mockRestore();
      delayedMutation.mockRestore();
    }
  });

  it("settles the owning waiter and publishes replay-triggered expiry once", async () => {
    vi.useFakeTimers();
    installTestApprovalClock();
    vi.setSystemTime(1_000);
    const databaseOptions = createDatabaseOptions();
    // Replay reconciliation runs only after the manager exists; route it
    // through a holder so both sides can stay const.
    const managerHolder: { current?: ExecApprovalManager } = {};
    const executionEvents: AgentEventPayload[] = [];
    subscriptions.push(
      onAgentEvent((event) => {
        if (event.runId === "approval-owner-run" && event.stream === "execution") {
          executionEvents.push(event);
        }
      }),
    );
    const parent = createReviewer("parent-reviewer", "parent-device");
    const harness = createRuntime({
      clients: [parent],
      reconcileTerminal: (record) =>
        managerHolder.current?.reconcileDurableTerminal(record) ?? false,
      getLiveManager: () => managerHolder.current,
    });
    const runtime = harness.runtime;
    const onExpired = vi.fn();
    const manager = new ExecApprovalManager({
      scheduler: createTestGatewayScheduler("fake-timers"),
      approvalKind: "exec",
      persistence: { runtimeEpoch: "session-events", databaseOptions },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      resolveAudienceSessionKeys: () => [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
      onLifecycle: (event) => runtime.publish(event),
      onExpired,
    });
    managerHolder.current = manager;
    harness.subscribers.subscribe("parent-reviewer", PARENT_SESSION_KEY, {
      includeApprovals: true,
    });
    const record = manager.create(
      {
        command: "printf replay-expiry",
        streamProposal: { jobId: "stream-attention", name: "Log watcher", operation: "add" },
        sessionKey: SOURCE_SESSION_KEY,
        sessionId: "approval-owner-session",
        runId: "approval-owner-run",
        agentId: "main",
      },
      3_000,
      "replay-expiry-with-waiter",
    );
    const decisionPromise = (await manager.register(record, 3_000)).decision;
    expect(executionEvents.map((event) => event.data)).toEqual([
      { approval: { id: record.id, state: "pending" } },
    ]);
    harness.broadcastToConnIds.mockClear();
    vi.setSystemTime(record.expiresAtMs);

    expect((await runtime.replay(SOURCE_SESSION_KEY, parent)).replay).toEqual({
      sessionKey: SOURCE_SESSION_KEY,
      updatedAtMs: record.expiresAtMs,
      approvals: [],
      truncated: false,
    });
    await expect(decisionPromise).resolves.toBeNull();
    expect(executionEvents.map((event) => event.data)).toEqual([
      { approval: { id: record.id, state: "pending" } },
      { approval: { id: record.id, state: "resolved" } },
    ]);
    expect(onExpired).toHaveBeenCalledOnce();
    expect(onExpired).toHaveBeenCalledWith(
      expect.objectContaining({ id: record.id, status: "expired" }),
      expect.objectContaining({
        id: record.id,
        request: expect.objectContaining({ command: "printf replay-expiry" }),
      }),
    );
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.approval",
      expect.objectContaining({
        sessionKey: PARENT_SESSION_KEY,
        phase: "terminal",
        approval: expect.objectContaining({ status: "expired" }),
      }),
      new Set(["parent-reviewer"]),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
  });

  it("does not revive attention from stale, unmatched, unavailable, or retired approval observations", () => {
    const record = createPendingRecord({
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    let current = true;
    let live: ExecApprovalRecord<OperatorApprovalRecord["source"]> = {
      id: record.id,
      request: record.source,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    };
    let managerAvailable = true;
    const manager = { runtimeEpoch: record.runtimeEpoch, getLiveSnapshot: () => live };
    const runtime = createRuntime({
      clients: [],
      getLiveManager: () => (managerAvailable ? manager : undefined),
      isCurrent: () => current,
    }).runtime;
    const executionEvents: AgentEventPayload[] = [];
    subscriptions.push(
      onAgentEvent((event) => {
        if (event.runId === record.source.runId && event.stream === "execution") {
          executionEvents.push(event);
        }
      }),
    );
    runtime.publish({ phase: "pending", record });
    expect(executionEvents).toHaveLength(1);
    executionEvents.length = 0;
    live = { ...live, resolvedAtMs: Date.now() };
    runtime.publish({ phase: "pending", record });
    live = {
      ...live,
      resolvedAtMs: undefined,
      request: { ...live.request, sessionId: "replacement-session" },
    };
    runtime.publish({ phase: "pending", record });
    live = {
      ...live,
      request: { ...live.request, sessionId: record.source.sessionId },
      expiresAtMs: Date.now() - 1,
    };
    runtime.publish({ phase: "pending", record });
    live = { ...live, expiresAtMs: record.expiresAtMs };
    manager.runtimeEpoch = "replacement-manager";
    runtime.publish({ phase: "pending", record });
    manager.runtimeEpoch = record.runtimeEpoch;
    managerAvailable = false;
    runtime.publish({ phase: "pending", record });
    managerAvailable = true;
    current = false;
    runtime.publish({ phase: "pending", record });
    expect(executionEvents).toEqual([]);
  });
});
