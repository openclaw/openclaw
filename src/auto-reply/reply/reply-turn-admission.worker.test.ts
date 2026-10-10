import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { replyRunRegistry, waitForReplyRunSuccessorAdmission } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

beforeEach(() => {
  expect(isMainThread).toBe(true);
});

afterEach(() => {
  testing.resetReplyRunRegistry();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

type Admission = Awaited<ReturnType<typeof admitReplyTurn>>;

function observeNativeOpen(databasePath: string, agentId: string) {
  const entered = createDeferred();
  const observed = probe.admission(workerAdmission, (request, grant, admit) => {
    admit(request, grant);
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
    const storePath = path.join(state.sessionsDir(), "agent.sqlite");
    const sessionKey = "agent:main:first-worker-admission";
    openOpenClawStateDatabase({ env: state.env });
    expect(fs.existsSync(storePath)).toBe(false);
    const sql = observeMainThreadSql({ includeClose: true });
    sql.calibrate();
    const opened = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    let result: Admission | undefined;
    try {
      const pending = admitReplyTurn({
        storePath,
        sessionKey,
        sessionId: "first-worker-admission-session",
        kind: "visible",
        resetTriggered: false,
      }).then((admitted) => {
        result = admitted;
        return admitted;
      });
      result = await pending;
      if (result.status !== "owned" || !result.databaseClaim) {
        throw new Error("First persistent admission must retain its database claim");
      }
      expect(result.sessionEntry).toBeUndefined();
      expect(result.databaseClaim.isCurrent()).toBe(true);
      expect(fs.existsSync(storePath)).toBe(true);
      await completeAdmission(result, sessionKey);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      sql.expectIdle();
      expect(opened).not.toHaveBeenCalled();
    } finally {
      try {
        await completeAdmission(result, sessionKey);
      } finally {
        opened.mockRestore();
        sql.restore();
      }
    }
  });
});

it("admits cold and reopened persistent replies without main-thread SQLite while a shared writer is held", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "agent.sqlite");
    const sessionKey = "agent:main:worker-admission";
    const sessionId = "worker-admission-session";
    replaceSessionEntrySync({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
    const statePath = openOpenClawStateDatabase({ env: state.env }).path;
    let previousIncarnation: string | undefined;

    for (const phase of ["cold", "reopened"] as const) {
      await closeOpenClawAgentDatabaseByPathAsync(storePath);
      const holder = holdStateDatabaseWriteTransaction(statePath, 10_000);
      await holder.ready;
      const releaseWriter = async () => {
        holder.release();
        await holder.joined;
      };
      const nativeOpen = observeNativeOpen(storePath, "main");
      const sql = observeMainThreadSql({ includeClose: true });
      sql.calibrate();
      const opened = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const controller = new AbortController();
      const pending = admitReplyTurn({
        storePath,
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        kind: "visible",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      });
      let settled = false;
      const settlement = pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let result: Admission | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            nativeOpen.entered,
            pending,
            `${phase} admission completed while its shared writer was held`,
          ),
          signal,
        );
        await setImmediate();
        expect(Atomics.load(holder.released, 0)).toBe(0);
        sql.expectIdle();
        expect(opened).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        await releaseWriter();
        result = await pending;
        expect(result.status).toBe("owned");
        if (result.status !== "owned" || !result.databaseClaim) {
          throw new Error("Persistent admission must retain its physical database claim");
        }
        expect(result.sessionEntry?.sessionId).toBe(sessionId);
        expect(result.databaseClaim.isCurrent()).toBe(true);
        if (previousIncarnation !== undefined) {
          expect(result.databaseClaim.incarnation).not.toBe(previousIncarnation);
        }
        previousIncarnation = result.databaseClaim.incarnation;
        await completeAdmission(result, sessionKey);
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
        sql.expectIdle();
        expect(opened).not.toHaveBeenCalled();
      } finally {
        try {
          controller.abort();
          await releaseWriter();
          result ??= await pending.catch(() => undefined);
          await completeAdmission(result, sessionKey);
          await settlement;
        } finally {
          nativeOpen.restore();
          opened.mockRestore();
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
    const storePath = path.join(state.sessionsDir(), "agent.sqlite");
    const sessionKey = "agent:main:cancel-worker-admission";
    const sessionId = "cancel-worker-admission-session";
    const followerKey = "agent:main:concurrent-worker-admission";
    const followerSessionId = "concurrent-worker-admission-session";
    replaceSessionEntrySync({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
    replaceSessionEntrySync(
      { storePath, sessionKey: followerKey },
      { sessionId: followerSessionId, updatedAt: 1 },
    );
    await closeOpenClawAgentDatabaseByPathAsync(storePath);
    const holder = holdStateDatabaseWriteTransaction(
      openOpenClawStateDatabase({ env: state.env }).path,
      10_000,
    );
    await holder.ready;
    const releaseWriter = async () => {
      holder.release();
      await holder.joined;
    };
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
    const request = {
      storePath,
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      kind: "visible" as const,
      resetTriggered: false,
    };
    const pending = admitReplyTurn({ ...request, upstreamAbortSignal: controller.signal });
    void pending.catch(() => undefined);
    const followerController = new AbortController();
    let follower: Promise<Admission> | undefined;
    let result: Admission | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          nativeOpen.entered,
          pending,
          "Admission completed before cancellation under contention",
        ),
        signal,
      );
      follower = admitReplyTurn({
        ...request,
        sessionKey: followerKey,
        sessionId: followerSessionId,
        expectedSessionId: followerSessionId,
        upstreamAbortSignal: followerController.signal,
      });
      void follower.catch(() => undefined);
      await withinTest(
        awaitGateBeforeSettlement(
          followerQueued.promise,
          follower,
          "Concurrent admission completed before entering the writer queue",
        ),
        signal,
      );
      controller.abort(new Error("Synthetic cancelled reply"));
      await setImmediate();
      expect(Atomics.load(holder.released, 0)).toBe(0);
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      expect(replyRunRegistry.get(followerKey)).toBeUndefined();
      await releaseWriter();
      await expect(pending).resolves.toEqual({ status: "skipped", reason: "aborted" });
      expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      result = await follower;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.sessionEntry?.sessionId).toBe(followerSessionId);
      }
      await completeAdmission(result, followerKey);
      expect(replyRunRegistry.get(followerKey)).toBeUndefined();
    } finally {
      try {
        controller.abort();
        followerController.abort();
        await releaseWriter();
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
      const activePath = path.join(state.sessionsDir(), "agent.sqlite");
      const activeKey = "agent:main:completion-close";
      const activeSessionId = "completion-active-session";
      const idleTargets = Array.from({ length: 4 }, (_, index) => {
        const agentId = `other-${index}`;
        return {
          agentId,
          storePath: path.join(state.sessionsDir(agentId), "agent.sqlite"),
          sessionKey: `agent:${agentId}:completion-idle`,
          sessionId: `completion-idle-session-${index}`,
        };
      });
      for (const { storePath, sessionKey, sessionId } of [
        { storePath: activePath, sessionKey: activeKey, sessionId: activeSessionId },
        ...idleTargets,
      ]) {
        replaceSessionEntrySync({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
      }
      const shared = openOpenClawStateDatabase({ env: state.env });
      const leases = shared.db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?");
      let active: Admission | undefined;
      const idleAdmissions: Array<{ sessionKey: string; admission: Admission }> = [];
      const work = new AsyncWorkScope();
      try {
        active = await work.run(() =>
          admitReplyTurn({
            storePath: activePath,
            sessionKey: activeKey,
            sessionId: activeSessionId,
            expectedSessionId: activeSessionId,
            kind: "visible",
            resetTriggered: false,
          }),
        );
        if (active.status !== "owned" || !active.databaseClaim) {
          throw new Error("Fixture requires an admitted persistent reply owner");
        }
        for (const target of idleTargets) {
          const admission = await admitReplyTurn({
            ...target,
            expectedSessionId: target.sessionId,
            kind: "visible",
            resetTriggered: false,
          });
          idleAdmissions.push({ sessionKey: target.sessionKey, admission });
          if (admission.status !== "owned") {
            throw new Error("Fixture requires four admitted idle reply owners");
          }
          await completeAdmission(admission, target.sessionKey);
          expect(leases.all(target.storePath)).toHaveLength(1);
        }
        expect(leases.all(activePath)).toHaveLength(1);

        const holder = holdStateDatabaseWriteTransaction(shared.path, 10_000);
        await holder.ready;
        const releaseWriter = async () => {
          holder.release();
          await holder.joined;
        };
        const sql = observeMainThreadSql({ includeClose: true });
        sql.calibrate();
        const opened = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
        let successor: ReturnType<typeof waitForReplyRunSuccessorAdmission> | undefined;
        try {
          // Drain forces physical retirement of the active owner and the full idle cache.
          markGatewayRestartDraining();
          if (ending !== "complete") {
            active.operation.setPhase("running");
            active.operation.attachBackend({
              kind: "embedded",
              runId: "completion-run",
              cancel() {},
            });
            if (ending === "frozen-restart") {
              active.operation.freezeAbort();
              work.beginClose(createAgentRunRestartAbortError());
              expect(active.operation.abortForRestart()).toBe(false);
              expect(active.operation.abortSignal.aborted).toBe(false);
            } else {
              expect(
                ending === "restart-abort"
                  ? active.operation.abortForRestart()
                  : active.operation.abortByUser(),
              ).toBe(true);
            }
            expect(active.databaseClaim.isCurrent()).toBe(ending === "user-abort");
            expect(replyRunRegistry.get(activeKey)).toBe(active.operation);
          }
          active.operation.complete();
          expect(active.databaseClaim.isCurrent()).toBe(false);
          let settled = false;
          successor = waitForReplyRunSuccessorAdmission(activeKey, null).then((result) => {
            settled = true;
            return result;
          });
          await setImmediate();
          expect(Atomics.load(holder.released, 0)).toBe(0);
          expect(settled).toBe(false);
          await releaseWriter();
          expect(await successor).toMatchObject({ settled: true });
          expect(replyRunRegistry.get(activeKey)).toBeUndefined();
          sql.expectIdle();
          expect(opened).not.toHaveBeenCalled();
        } finally {
          try {
            await releaseWriter();
            await successor;
          } finally {
            opened.mockRestore();
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
