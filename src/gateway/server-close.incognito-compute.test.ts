import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import type { SessionActorStorageReads } from "../config/sessions/session-actor-storage-contract.js";
import { refreshCostUsageCacheForAgent } from "../infra/session-cost-usage-aggregation.js";
import * as usageEvents from "../infra/session-cost-usage-events.js";
import * as usagePricing from "../infra/session-cost-usage-pricing-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSqliteTrajectoryRuntimeSink } from "../trajectory/runtime-store-writer.js";
import { createTrajectoryEvent } from "../trajectory/runtime-store.test-support.js";
import { createIncognitoCloseSession } from "./server-close.metadata.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("settles accepted memory usage and trajectory work across the real close prelude", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("incognito-compute-close", signal);
  const { fixture, kernel } = race;
  const joining = new AbortController();
  const verified = createDeferredCore();
  const finish = createDeferredCore();
  void verified.promise.catch(() => undefined);
  let actor: SessionActor | undefined;
  let job: Promise<void> | undefined;
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  try {
    const session = await createIncognitoCloseSession(
      fixture,
      "agent:main:dashboard:incognito-compute-close",
      "compute-close",
    );
    const { owner, authority, target, created, actor: selected } = session;
    actor = selected;
    expect(created).toMatchObject({ kind: "committed" });
    const read = <Key extends keyof SessionActorStorageReads>(
      type: Key,
      input: SessionActorStorageReads[Key]["input"],
    ) => selected.storage!.read({ type, input }, authority);
    for (const [index, content] of ["old branch", "accepted current branch"].entries()) {
      const appended = await selected.appendToolResult(
        {
          commandId: `compute-message-${index}`,
          phaseId: "compute-close",
          turn: {
            agentId: "main",
            sessionKey: target.sessionKey,
            options: {
              expectedSessionId: target.sessionId,
              sessionFile: formatSqliteSessionFileMarker(target),
              messages: [
                {
                  eventId: `message-${index}`,
                  parentId: null,
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: content }],
                    timestamp: 10_000,
                    provider: "test",
                    model: "test",
                    usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
                  },
                },
              ],
            },
          },
        },
        authority,
      );
      expect(appended).toMatchObject({ kind: "committed" });
    }
    const sessionFile = formatSqliteSessionFileMarker(target);
    const trajectory = await createSqliteTrajectoryRuntimeSink({
      env: fixture.state.env,
      sessionId: target.sessionId,
      sessionTarget: target,
      maxRuntimeFileBytes: 1024 * 1024,
    });
    assert(trajectory);
    const event = createTrajectoryEvent({
      type: "accepted-before-close",
      sessionId: target.sessionId,
    });
    trajectory.write(event, JSON.stringify(event));
    const previousUsageUpdatedAt = usageEvents.getSessionCostUsageUpdatedAt();
    const published = vi.spyOn(usageEvents, "publishSessionCostUsageUpdated");
    const preparePricing = usagePricing.prepareUsageCostPricing;
    vi.spyOn(usagePricing, "prepareUsageCostPricing").mockImplementationOnce(async (...args) => {
      const pricing = await preparePricing(...args);
      await race.block();
      return pricing;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "incognito-compute-settlement",
      delayMs: 0,
      run() {
        job = (async () => {
          const refreshed = await refreshCostUsageCacheForAgent({
            config: fixture.config,
            env: fixture.state.env,
            agentId: "main",
            databasePath: owner.path,
            storePath: owner.path,
            sessionFiles: [sessionFile],
          });
          expect(
            await read("session.history.recent", {
              sessionId: target.sessionId,
              options: { maxMessages: 10 },
            }),
          ).toMatchObject({
            totalMessages: 1,
            messages: [{ content: [{ type: "text", text: "accepted current branch" }] }],
          });
          expect(refreshed).toBe("refreshed");
          await trajectory.flush();
          expect(trajectory.describeFlushState()).toBeUndefined();
          expect(await read("session.trajectory.read", { sessionId: target.sessionId })).toEqual([
            event,
          ]);
          expect(
            await read("session.usage.snapshot", { sessionIds: [target.sessionId] }),
          ).toMatchObject([
            { sessionId: target.sessionId, rollup: { valueJson: expect.any(String) } },
          ]);
          expect(published).toHaveBeenCalledExactlyOnceWith("main");
          expect(usageEvents.getSessionCostUsageUpdatedAt()).toBeGreaterThan(
            previousUsageUpdatedAt,
          );
          verified.resolve();
          await finish.promise;
        })().catch((error: unknown) => {
          verified.reject(error);
          throw error;
        });
        return job;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await race.waitForEntry(job);
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.abort();
      return stop();
    });
    await race.close(joining.signal, undefined, { reason: "incognito compute close proof" });
    expect(() => selected.assertReadable()).not.toThrow();
    sql = observeHostDataSql();
    const finishing = race.finish(job);
    void finishing.catch(() => undefined);
    await withinTest(verified.promise, signal);
    expect(sql.queries).toEqual([]);
    sql.restore();
    sql = undefined;
    finish.resolve();
    await finishing;
    expect(() => selected.assertReadable()).toThrow("closed");
  } finally {
    vi.useRealTimers();
    finish.resolve();
    sql?.restore();
    race.onCleanup(async () => {
      vi.restoreAllMocks();
      await actor?.release();
    });
    await race.dispose();
  }
});
