import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import { refreshCostUsageCacheForAgent } from "../infra/session-cost-usage-aggregation.js";
import { onSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import * as usagePricing from "../infra/session-cost-usage-pricing-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createSqliteTrajectoryRuntimeSink } from "../trajectory/runtime-store-writer.js";
import { createTrajectoryEvent } from "../trajectory/runtime-store.test-support.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles accepted memory usage and trajectory work across the real close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("incognito-compute-close");
  const release = createDeferredCore();
  const accepted = createDeferredCore();
  const joining = createDeferredCore();
  const verified = createDeferredCore();
  const finish = createDeferredCore();
  void verified.promise.catch(() => undefined);
  let actor: SessionActor | undefined;
  let job: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const authority = { assertCurrent() {}, authorize() {} };
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env }),
    });
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-compute-close",
      sessionId: "compute-close",
      storePath: owner.path,
    };
    actor = await owner.acquire(
      { database: owner.identity, sessionKey: target.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const selected = actor;
    expect(
      (
        await selected.storage!.mutate(
          {
            type: "session.entry.create",
            input: { entry: { sessionId: target.sessionId, updatedAt: 1, incognito: true } },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    for (const [index, content] of ["old branch", "accepted current branch"].entries()) {
      expect(
        (
          await selected.appendToolResult(
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
          )
        ).kind,
      ).toBe("committed");
    }
    const database = { agentId: "main", path: owner.path, env: fixture.state.env };
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
    const published = vi.fn();
    unsubscribe = onSessionCostUsageUpdated(published);
    const preparePricing = usagePricing.prepareUsageCostPricing;
    vi.spyOn(usagePricing, "prepareUsageCostPricing").mockImplementationOnce(async (...args) => {
      try {
        const pricing = await preparePricing(...args);
        accepted.resolve();
        await release.promise;
        return pricing;
      } catch (error) {
        accepted.reject(error);
        throw error;
      }
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
          // Memory projections are already current; reconciliation allocates no work.
          startSessionTranscriptIndexReconcile(database);
          await waitForSessionTranscriptIndexReconcile(database);
          expect(isSessionTranscriptIndexReconcileRunning(database)).toBe(false);
          expect(
            await selected.storage!.read(
              {
                type: "session.history.recent",
                input: { sessionId: target.sessionId, options: { maxMessages: 10 } },
              },
              authority,
            ),
          ).toMatchObject({
            totalMessages: 1,
            messages: [{ content: [{ type: "text", text: "accepted current branch" }] }],
          });
          expect(refreshed).toBe("refreshed");
          await trajectory.flush();
          expect(trajectory.describeFlushState()).toBeUndefined();
          expect(
            await selected.storage!.read(
              {
                type: "session.trajectory.read",
                input: { sessionId: target.sessionId },
              },
              authority,
            ),
          ).toEqual([event]);
          const usage = await selected.storage!.read(
            {
              type: "session.usage.snapshot",
              input: { sessionIds: [target.sessionId] },
            },
            authority,
          );
          expect(usage).toMatchObject([
            { sessionId: target.sessionId, rollup: { valueJson: expect.any(String) } },
          ]);
          expect(published).toHaveBeenCalledOnce();
          expect(published).toHaveBeenCalledWith({
            agentId: "main",
            usageUpdatedAt: expect.any(Number),
          });
          verified.resolve();
          await finish.promise;
        })().catch((error: unknown) => {
          accepted.reject(error);
          verified.reject(error);
          throw error;
        });
        return job;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(accepted.promise, signal);
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.resolve();
      return stop();
    });
    closing = server.close({ reason: "incognito compute close proof" });
    await withinTest(
      awaitGateBeforeSettlement(joining.promise, closing, "Gateway skipped compute settlement"),
      signal,
    );
    expect(() => selected.assertReadable()).not.toThrow();
    sql = observeHostDataSql();
    release.resolve();
    await withinTest(verified.promise, signal);
    expect(sql.queries).toEqual([]);
    sql.restore();
    sql = undefined;
    finish.resolve();
    await closing;
    expect(() => selected.assertReadable()).toThrow("closed");
  } finally {
    vi.useRealTimers();
    release.resolve();
    finish.resolve();
    sql?.restore();
    unsubscribe?.();
    await Promise.allSettled([job, closing]);
    vi.restoreAllMocks();
    await actor?.release();
    await fixture.cleanup();
  }
});
