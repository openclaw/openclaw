import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { deleteIncognitoSessionLifecycle } from "../config/sessions/session-incognito-lifecycle-operations.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startIncognitoActorSessionLifetime } from "./session-incognito-lifetime.js";

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
        await actor.sessions.create(authority, {
          sessionKey,
          entry: { ...entry, createdAt: time.clock.now(), updatedAt: time.clock.now() },
        });
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
