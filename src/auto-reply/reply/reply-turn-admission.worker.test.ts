import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
} from "../../sessions/session-controller.session-reader.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

type Admission = Awaited<ReturnType<typeof admitReplyTurn>>;

function admit(params: Omit<Parameters<typeof admitReplyTurn>[0], "kind" | "resetTriggered">) {
  return admitReplyTurn({ kind: "visible", resetTriggered: false, ...params });
}

function makeTarget(state: OpenClawTestState, name: string, agentId = "main", seed = true) {
  const storePath = path.join(state.sessionsDir(agentId), "agent.sqlite");
  const sessionKey = `agent:${agentId}:${name}`;
  const sessionId = `${agentId}-${name}-session`;
  if (seed) {
    replaceSessionEntrySync({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
  }
  return { ...(agentId === "main" ? {} : { agentId }), storePath, sessionKey, sessionId };
}

function trackSettlement<T>(pending: Promise<T>) {
  let settled = false;
  const done = () => {
    settled = true;
  };
  return { pending, done: pending.then(done, done), isSettled: () => settled };
}

function waitAtGate(
  gate: Promise<void>,
  pending: Promise<unknown>,
  message: string,
  signal: AbortSignal,
) {
  return withinTest(awaitGateBeforeSettlement(gate, pending, message), signal);
}

function requireOwned(result: Admission) {
  assert(result.status === "owned" && result.databaseClaim, "Expected persistent reply admission");
  return { ...result, databaseClaim: result.databaseClaim };
}

function observeSql() {
  const sql = observeMainThreadSql({ includeClose: true });
  const opened = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  return {
    expectIdle() {
      sql.expectIdle();
      expect(opened).not.toHaveBeenCalled();
    },
    restore() {
      opened.mockRestore();
      sql.restore();
    },
  };
}

async function holdWriter(databasePath: string) {
  const holder = holdStateDatabaseWriteTransaction(databasePath, 10_000);
  await holder.ready;
  return {
    released: holder.released,
    async release() {
      holder.release();
      await holder.joined;
    },
  };
}

function observeNativeOpen(databasePath: string, agentId: string) {
  const entered = createDeferred();
  const observed = probe.admission(workerAdmission, (request, grant, admitRequest) => {
    admitRequest(request, grant);
    if (
      request.stage === "open" &&
      isRecord(request.facts) &&
      request.facts.databasePath === databasePath &&
      request.facts.agentId === agentId
    ) {
      entered.resolve();
    }
  });
  return { entered: entered.promise, restore: () => observed.mockRestore() };
}

async function completeAdmission(result: Admission | undefined, sessionKey: string) {
  if (result?.status === "owned") {
    result.operation.complete();
    expect(result.databaseClaim?.isCurrent()).toBe(false);
    expect(await waitForReplyRunSuccessorAdmission(sessionKey, null)).toMatchObject({
      settled: true,
    });
  }
}

it("creates a missing persistent store through reply admission without main-thread SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const request = makeTarget(state, "first-worker-admission", "main", false);
    const { storePath, sessionKey } = request;
    openOpenClawStateDatabase({ env: state.env });
    expect(fs.existsSync(storePath)).toBe(false);
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    const sharing = await prepareSessionMutationFacts({
      cfg,
      agentId: "main",
      sessionKey,
      allowMissing: true,
    });
    const sql = observeSql();
    let result: Admission | undefined;
    try {
      result = await admit({
        ...request,
        onDatabaseRegistration: sharing.followRegistration,
      });
      const owned = requireOwned(result);
      expect(owned.sessionEntry).toBeUndefined();
      expect(owned.databaseClaim.isCurrent()).toBe(true);
      expect(fs.existsSync(storePath)).toBe(true);
      expect(sharing.readCurrent(cfg).target).toBeNull();
      await completeAdmission(result, sessionKey);
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      sql.expectIdle();
    } finally {
      try {
        await completeAdmission(result, sessionKey);
      } finally {
        sql.restore();
        sharing.release();
      }
    }
  });
});

it("retains one actor per cold/reopened reply admission and drains it without main-thread SQLite", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const request = makeTarget(state, "worker-admission");
    const { storePath, sessionKey, sessionId } = request;
    const statePath = openOpenClawStateDatabase({ env: state.env }).path;
    let previousIncarnation: string | undefined;

    for (const phase of ["cold", "reopened"] as const) {
      await closeOpenClawAgentDatabaseByPathAsync(storePath);
      const holder = await holdWriter(statePath);
      const nativeOpen = observeNativeOpen(storePath, "main");
      const sql = observeSql();
      const controller = new AbortController();
      const pending = admit({
        ...request,
        expectedSessionId: sessionId,
        upstreamAbortSignal: controller.signal,
      });
      const settlement = trackSettlement(pending);
      let result: Admission | undefined;
      const releaseActorPhase = createDeferred();
      let actorPhase: Promise<void> | undefined;
      try {
        await waitAtGate(
          nativeOpen.entered,
          pending,
          `${phase} admission completed while its shared writer was held`,
          signal,
        );
        await setImmediate();
        expect(Atomics.load(holder.released, 0)).toBe(0);
        sql.expectIdle();
        expect(settlement.isSettled()).toBe(false);
        await holder.release();
        result = await pending;
        const owned = requireOwned(result);
        expect(owned.sessionEntry?.sessionId).toBe(sessionId);
        expect(owned.databaseClaim.isCurrent()).toBe(true);
        if (previousIncarnation !== undefined) {
          expect(owned.databaseClaim.incarnation).not.toBe(previousIncarnation);
        }
        previousIncarnation = owned.databaseClaim.incarnation;
        const { operation, databaseClaim } = owned;
        const [actor, sibling] = await Promise.all([
          acquireReplyOperationSessionActor(operation),
          acquireReplyOperationSessionActor(operation),
        ]);
        assert(actor && sibling, "Persistent admission must acquire a session actor");
        expect(sibling).toBe(actor);
        const authority = {
          assertCurrent: () => databaseClaim.assertCurrent(),
          authorize() {},
        };
        const phaseEntered = createDeferred();
        actorPhase = actor.withPhase("retained-reply", authority, async () => {
          phaseEntered.resolve();
          await releaseActorPhase.promise;
        });
        await withinTest(phaseEntered.promise, signal);
        operation.complete();
        expect(() => actor.snapshot(authority)).toThrow();
        expect(() => acquireReplyOperationSessionActor(operation)).toThrow();
        const successor = trackSettlement(waitForReplyRunSuccessorAdmission(sessionKey, null));
        await setImmediate();
        expect(successor.isSettled()).toBe(false);
        expect(databaseClaim.isCurrent()).toBe(true);
        releaseActorPhase.resolve();
        await withinTest(actorPhase, signal);
        expect(await withinTest(successor.pending, signal)).toMatchObject({ settled: true });
        expect(databaseClaim.isCurrent()).toBe(false);
        expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
        sql.expectIdle();
      } finally {
        try {
          releaseActorPhase.resolve();
          await Promise.allSettled([actorPhase]);
          controller.abort();
          await holder.release();
          result ??= await pending.catch(() => undefined);
          if (result?.status === "owned") {
            result.operation.complete();
            await waitForReplyRunSuccessorAdmission(sessionKey, null);
          }
          await completeAdmission(result, sessionKey);
          await settlement.done;
        } finally {
          nativeOpen.restore();
          sql.restore();
        }
      }
    }
  });
});

it("cancels a contended persistent admission without claiming the reply or poisoning a concurrent admission", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const initial = makeTarget(state, "cancel-worker-admission");
    const concurrent = makeTarget(state, "concurrent-worker-admission");
    const { storePath, sessionKey, sessionId } = initial;
    const { sessionKey: followerKey, sessionId: followerSessionId } = concurrent;
    await closeOpenClawAgentDatabaseByPathAsync(storePath);
    const holder = await holdWriter(openOpenClawStateDatabase({ env: state.env }).path);
    const nativeOpen = observeNativeOpen(storePath, "main");
    const followerQueued = createDeferred();
    const enqueue = agentWriteAdmission.runOpenClawAgentWorkerWrite;
    let queued = 0;
    const observedQueue = vi
      .spyOn(agentWriteAdmission, "runOpenClawAgentWorkerWrite")
      .mockImplementation((...args) => {
        const pendingWrite = enqueue(...args);
        if (!("target" in args[0]) && args[0].path === storePath && ++queued === 2) {
          followerQueued.resolve();
        }
        return pendingWrite;
      });
    const controller = new AbortController();
    const pending = admit({
      ...initial,
      expectedSessionId: sessionId,
      upstreamAbortSignal: controller.signal,
    });
    void pending.catch(() => undefined);
    const followerController = new AbortController();
    let follower: Promise<Admission> | undefined;
    let result: Admission | undefined;
    try {
      await waitAtGate(
        nativeOpen.entered,
        pending,
        "Admission completed before cancellation under contention",
        signal,
      );
      follower = admit({
        ...concurrent,
        expectedSessionId: followerSessionId,
        upstreamAbortSignal: followerController.signal,
      });
      void follower.catch(() => undefined);
      await waitAtGate(
        followerQueued.promise,
        follower,
        "Concurrent admission completed before entering the writer queue",
        signal,
      );
      controller.abort(new Error("Synthetic cancelled reply"));
      await setImmediate();
      expect(Atomics.load(holder.released, 0)).toBe(0);
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      expect(getSessionControllerOperation(followerKey)).toBeUndefined();
      await holder.release();
      await expect(pending).resolves.toEqual({ status: "skipped", reason: "aborted" });
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      result = await follower;
      expect(result).toMatchObject({
        status: "owned",
        sessionEntry: { sessionId: followerSessionId },
      });
      await completeAdmission(result, followerKey);
      expect(getSessionControllerOperation(followerKey)).toBeUndefined();
    } finally {
      try {
        controller.abort();
        followerController.abort();
        await holder.release();
        result ??= await follower?.catch(() => undefined);
        await completeAdmission(result, followerKey);
        await completeAdmission(await pending.catch(() => undefined), sessionKey);
      } finally {
        nativeOpen.restore();
        observedQueue.mockRestore();
      }
    }
  });
});

it.each(["complete", "user-abort", "restart-abort", "frozen-restart"] as const)(
  "keeps successors behind physical claim release after %s during executor drain with a full idle cache",
  async (ending) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const activeTarget = makeTarget(state, "completion-close");
      const { storePath: activePath, sessionKey: activeKey } = activeTarget;
      const idleTargets = Array.from({ length: 4 }, (_, index) =>
        makeTarget(state, "completion-idle", `other-${index}`),
      );
      for (const { storePath } of [activeTarget, ...idleTargets]) {
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
      }
      const shared = openOpenClawStateDatabase({ env: state.env });
      const leases = shared.db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?");
      let active: Admission | undefined;
      const idleAdmissions: Array<{ sessionKey: string; admission: Admission }> = [];
      const work = new AsyncWorkScope();
      try {
        active = await work.run(() =>
          admit({
            ...activeTarget,
            expectedSessionId: activeTarget.sessionId,
          }),
        );
        const { operation, databaseClaim } = requireOwned(active);
        for (const target of idleTargets) {
          const admission = await admit({
            ...target,
            expectedSessionId: target.sessionId,
          });
          idleAdmissions.push({ sessionKey: target.sessionKey, admission });
          assert(admission.status === "owned", "Fixture requires four admitted idle reply owners");
          await completeAdmission(admission, target.sessionKey);
          expect(leases.all(target.storePath)).toHaveLength(1);
        }
        expect(leases.all(activePath)).toHaveLength(1);

        const holder = await holdWriter(shared.path);
        const sql = observeSql();
        let successor: ReturnType<typeof waitForReplyRunSuccessorAdmission> | undefined;
        try {
          // Drain forces physical retirement of the active owner and the full idle cache.
          markGatewayRestartDraining();
          if (ending !== "complete") {
            operation.setPhase("running");
            operation.attachBackend({
              kind: "embedded",
              runId: "completion-run",
              cancel() {},
            });
            if (ending === "frozen-restart") {
              operation.freezeAbort();
              const restartReason = createAgentRunRestartAbortError();
              work.beginClose(restartReason);
              expect(operation.abortForRestart()).toBe(false);
              expect(operation.abortSignal.aborted).toBe(false);
              expect(() => getReplyOperationSessionTarget(operation)).toThrow(restartReason);
            } else {
              expect(
                ending === "restart-abort" ? operation.abortForRestart() : operation.abortByUser(),
              ).toBe(true);
            }
            expect(databaseClaim.isCurrent()).toBe(ending === "user-abort");
            expect(getSessionControllerOperation(activeKey)).toBe(operation);
          }
          operation.complete();
          expect(databaseClaim.isCurrent()).toBe(false);
          const settlement = trackSettlement(waitForReplyRunSuccessorAdmission(activeKey, null));
          successor = settlement.pending;
          await setImmediate();
          expect(Atomics.load(holder.released, 0)).toBe(0);
          expect(settlement.isSettled()).toBe(false);
          await holder.release();
          expect(await successor).toMatchObject({ settled: true });
          expect(getSessionControllerOperation(activeKey)).toBeUndefined();
          sql.expectIdle();
        } finally {
          try {
            await holder.release();
            await successor;
          } finally {
            sql.restore();
          }
        }
        expect(leases.all(activePath)).toEqual([]);
        for (const target of idleTargets) {
          await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
          expect(leases.all(target.storePath)).toEqual([]);
        }
      } finally {
        await completeAdmission(active, activeKey);
        for (const { admission, sessionKey } of idleAdmissions) {
          await completeAdmission(admission, sessionKey);
        }
        await work.drain();
      }
    });
  },
);
