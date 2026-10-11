import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureIncognitoSessionBinding,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { deleteIncognitoSessionLifecycle } from "../config/sessions/session-incognito-lifecycle-operations.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import * as deletion from "./server-methods/sessions-delete.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import {
  startIncognitoActorsSessionLifetime,
  startIncognitoActorSessionLifetime,
} from "./session-incognito-lifetime.js";

// Two retained private actors plus shared-state cleanup need three broker slots.
vi.mock("../infra/worker-pool-sizing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-pool-sizing.js")>()),
  resolveSqliteBrokerWorkerCount: () => 3,
}));

it.for(["sidecar", "actor"] as const)(
  "keeps the original actor deadline and joins accepted expiry before %s shutdown",
  async (shutdown, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const time = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(time.clock);
      const authority = { assertCurrent() {} };
      const actor = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: "main",
        env: state.env,
        authority,
      });
      assert(actor);
      const sessionKey = "agent:main:dashboard:incognito-expiry-actor";
      const entry = {
        sessionId: "expiry",
        incognito: true as const,
        createdAt: time.clock.now(),
        updatedAt: time.clock.now(),
      };
      await actor.sessions.create(authority, { sessionKey, entry });
      const deadlineSource = actor.sessions.deadlines()[0]?.source;
      assert(deadlineSource);
      const started = createDeferredCore();
      const release = createDeferredCore();
      const completed = createDeferredCore();
      const order: string[] = [];
      let assertExpiredWorkCurrent: (() => void) | undefined;
      const logWarning = vi.fn();
      const owner = startIncognitoActorSessionLifetime({
        actor,
        scheduler,
        logWarning,
        async deleteSession(deadline, assertCurrent) {
          assertExpiredWorkCurrent = assertCurrent;
          started.resolve();
          await release.promise;
          try {
            assertCurrent();
            expect(deadline.sessionId).toBe(entry.sessionId);
            const current = await actor.sessions.read({ assertCurrent }, { sessionKey });
            assert(current.entry);
            const result = await deleteIncognitoSessionLifecycle({
              actor,
              authority: { assertCurrent },
              env: state.env,
              target: { sessionKey, entry: current.entry },
              reason: "deleted",
            });
            expect(result.deleted).toBe(true);
            order.push("deleted");
            completed.resolve();
          } catch (error) {
            completed.reject(error);
            throw error;
          }
        },
      });
      let stopping: Promise<void> | undefined;
      let waking: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      try {
        await time.advanceBy(23 * 60 * 60_000);
        const updated = await withIncognitoSessionBinding({ actor }, () =>
          patchSessionEntryCore(
            { agentId: actor.agentId, sessionKey, storePath: actor.path, env: state.env },
            () => ({ createdAt: time.clock.now(), updatedAt: time.clock.now() }),
          ),
        );
        expect(updated?.createdAt).toBe(entry.createdAt);
        expect(updated?.updatedAt).toBeGreaterThan(entry.updatedAt);
        const sql = observeMainThreadSql();
        try {
          sessionChanges.emit({ agentId: actor.agentId, storePath: actor.path, sessionKey });
          sql.expectIdle();
        } finally {
          sql.restore();
        }
        await time.advanceBy(60 * 60_000 - 1);
        expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeDefined();
        waking = Promise.resolve(time.advanceBy(1));
        await withinTest(started.promise, signal);
        let stopped = false;
        stopping = Promise.resolve(owner.stop()).then(() => {
          stopped = true;
          order.push("stopped");
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        if (shutdown === "actor") {
          closing = actor.close().then(() => {
            order.push("closed");
          });
          expect(() => actor.assertCurrent()).toThrow();
          expect(() => deadlineSource.assertSettlingCurrent()).toThrow();
          expect(order).toEqual([]);
        }
        release.resolve();
        await withinTest(completed.promise, signal);
        await stopping;
        await closing;
        expect(order[0]).toBe("deleted");
        expect(order).toContain("stopped");
        assert(assertExpiredWorkCurrent);
        expect(assertExpiredWorkCurrent).toThrow("no longer owns this session");
        if (shutdown === "actor") {
          expect(order).toContain("closed");
        } else {
          expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
          deadlineSource.assertSettlingCurrent();
          await actor.sessions.create(authority, {
            sessionKey,
            entry: { ...entry, sessionId: "successor", createdAt: time.clock.now() },
          });
          expect(() => deadlineSource.assertSettlingCurrent()).toThrow(
            "no longer owns this session",
          );
        }
        expect(logWarning).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await waking;
        await stopping;
        await closing;
        await owner.stop();
        await scheduler.stop();
        await actor.close();
      }
    });
  },
);

it("follows new actors and retires an old incarnation before expiring its successor", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const authority = { assertCurrent() {} };
    const time = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(time.clock);
    const opened: IncognitoAgentDatabaseExecution[] = [];
    const expected = new Map<string, string>();
    const createActor = async (agentId: string, sessionId: string) => {
      const actor = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId,
        env: state.env,
        authority,
      });
      assert(actor);
      opened.push(actor);
      expected.set(agentId, actor.identity.incarnation);
      await actor.sessions.create(authority, {
        sessionKey: `agent:${agentId}:dashboard:incognito-all-expiry`,
        entry: {
          sessionId,
          incognito: true,
          createdAt: time.clock.now(),
          updatedAt: time.clock.now(),
        },
      });
      return actor;
    };
    const empty = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "empty",
      env: state.env,
      authority,
    });
    assert(empty);
    opened.push(empty);
    const first = await createActor("main", "main-original");
    const gates = [createDeferredCore(), createDeferredCore(), createDeferredCore()];
    const scheduled: AbortSignal[] = [];
    const createScope = scheduler.scope.bind(scheduler);
    const scheduling = vi.spyOn(scheduler, "scope").mockImplementation(() => {
      const scope = createScope();
      const schedule = scope.schedule;
      scope.schedule = (params) => {
        const job = schedule(params);
        scheduled.push(scope.signal);
        gates[scheduled.length - 1]?.resolve();
        return job;
      };
      return scope;
    });
    const deleted: string[] = [];
    const deleting = vi
      .spyOn(deletion, "deleteGatewaySession")
      .mockImplementation(async (params) => {
        const binding = captureIncognitoSessionBinding({ sessionKey: params.params.key });
        assert(binding);
        expect(binding.actor.identity.incarnation).toBe(expected.get(binding.actor.agentId));
        const current = await binding.actor.sessions.read(authority, {
          sessionKey: params.params.key,
        });
        assert(current.entry);
        expect(current.entry.sessionId).toBe(params.params.expectedSessionId);
        const result = await deleteIncognitoSessionLifecycle({
          actor: binding.actor,
          authority: { assertCurrent: () => params.assertCurrent?.() },
          env: state.env,
          target: { sessionKey: params.params.key, entry: current.entry },
          reason: "deleted",
        });
        deleted.push(current.entry.sessionId);
        return {
          ok: true,
          result: { ok: true, key: params.params.key, deleted: result.deleted, archived: [] },
        };
      });
    const context = createDirectChatContext();
    const logWarning = vi.fn();
    const owner = createGatewaySidecarStopOwner();
    owner.publish(
      startIncognitoActorsSessionLifetime({ context, scheduler, logWarning, env: state.env }),
    );
    const publish = (actor: typeof first) =>
      sessionChanges.emit({
        agentId: actor.agentId,
        storePath: actor.path,
        sessionKey: `agent:${actor.agentId}:dashboard:incognito-all-expiry`,
      });
    try {
      // No session publication accompanies this empty actor's loss after topology capture.
      await empty.close();
      await withinTest(gates[0]!.promise, signal);
      const added = await createActor("work", "work-added");
      publish(added);
      await withinTest(gates[1]!.promise, signal);
      await time.advanceBy(60 * 60_000);
      await first.close();
      const successor = await createActor("main", "main-successor");
      publish(successor);
      await withinTest(gates[2]!.promise, signal);
      expect(scheduled[0]?.aborted).toBe(true);
      expect(() => first.assertCurrent()).toThrow();
      const sql = observeMainThreadSql();
      try {
        await time.advanceBy(23 * 60 * 60_000);
        expect(deleted).toEqual(["work-added"]);
        await time.advanceBy(60 * 60_000);
        owner.beginClose();
        await owner.stop();
        await owner.sealAndJoin();
        expect(deleted).toEqual(["work-added", "main-successor"]);
        expect(logWarning).toHaveBeenCalledExactlyOnceWith(
          "Incognito expiry could not reconcile a captured actor.",
        );
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    } finally {
      await owner.stop();
      await scheduler.stop();
      scheduling.mockRestore();
      deleting.mockRestore();
      await Promise.all(opened.map((actor) => actor.close()));
    }
  });
});
