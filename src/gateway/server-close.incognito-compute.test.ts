import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { IncognitoTranscriptOperations } from "../config/sessions/session-incognito-transcript-contract.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import { refreshCostUsageCacheForAgent } from "../infra/session-cost-usage-aggregation.js";
import { onSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles accepted actor reconciliation and usage publication across the real close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("incognito-compute-close");
  const release = createDeferredCore();
  const finish = createDeferredCore();
  const prelude = createDeferredCore();
  const work = new AsyncWorkScope();
  let job: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const authority = { assertCurrent() {} };
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: fixture.state.env,
      authority,
    });
    assert(actor);
    const target = {
      sessionKey: "agent:main:dashboard:incognito-compute-close",
      sessionId: "compute-close",
    };
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: { sessionId: target.sessionId, updatedAt: 1, incognito: true },
    });
    for (const content of ["old branch", "accepted current branch"]) {
      const appended: IncognitoTranscriptOperations["session.message.append"]["output"] =
        await actor.sessions.transcript(authority, {
          type: "session.message.append",
          input: {
            ...target,
            fence: {},
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
        });
      assert(appended.ok);
    }
    const binding = { actor, authority };
    const database = { agentId: actor.agentId, path: actor.path, env: fixture.state.env };
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: actor.agentId,
      storePath: actor.path,
      sessionId: target.sessionId,
    });
    const refresh = {
      config: fixture.config,
      agentId: actor.agentId,
      databasePath: actor.path,
      storePath: actor.path,
      sessionFiles: [sessionFile],
      incognito: binding,
    };
    const projectionReady = createDeferredCore();
    const usageReady = createDeferredCore();
    const joining = createDeferredCore();
    const verified = createDeferredCore();
    void verified.promise.catch(() => undefined);
    const published = vi.fn();
    unsubscribe = onSessionCostUsageUpdated(published);
    const withCompute = actor.sessions.withCompute;
    vi.spyOn(actor.sessions, "withCompute").mockImplementation(
      (caller, selected, operation, abort) =>
        withCompute(
          caller,
          selected,
          (compute) =>
            operation({
              assertCurrent: compute.assertCurrent,
              async execute(command) {
                if (command.type === "session.compute.projection.finalize") {
                  projectionReady.resolve();
                  await release.promise;
                } else if (command.type === "session.compute.store.writeRollup") {
                  usageReady.resolve();
                  await release.promise;
                }
                return compute.execute(command);
              },
            }),
          abort,
        ),
    );
    kernel.scheduler.signal.addEventListener(
      "abort",
      () => {
        work.beginClose(kernel.scheduler.signal.reason);
        prelude.resolve();
      },
      { once: true },
    );
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.resolve();
      return stop();
    });
    sql = observeHostDataSql();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "incognito-compute-settlement",
      delayMs: 0,
      run() {
        job = work
          .run(async () => {
            startSessionTranscriptIndexReconcile(database, binding);
            const reconciling = waitForSessionTranscriptIndexReconcile(database, binding);
            const refreshing = refreshCostUsageCacheForAgent(refresh);
            const accepted = Promise.all([reconciling, refreshing]);
            void accepted.catch((error: unknown) => {
              projectionReady.reject(error);
              usageReady.reject(error);
            });
            await prelude.promise;
            expect(() => startSessionTranscriptIndexReconcile(database, binding)).toThrow();
            await expect(refreshCostUsageCacheForAgent(refresh)).rejects.toThrow();
            await release.promise;
            expect((await accepted)[1]).toBe("refreshed");
            await expect(
              actor.sessions.history(authority, {
                type: "session.history.recent",
                input: { ...target, options: { maxMessages: 10 } },
              }),
            ).resolves.toMatchObject({
              totalMessages: 1,
              messages: [{ content: [{ type: "text", text: "accepted current branch" }] }],
            });
            await actor.sessions.withCompute(authority, undefined, async (compute) => {
              expect(
                await compute.execute({
                  type: "session.compute.store.cache",
                  input: { request: { filePaths: [sessionFile] } },
                }),
              ).toHaveLength(1);
              expect(
                await compute.execute({
                  type: "session.compute.store.refreshLock",
                  input: { request: {} },
                }),
              ).toBeNull();
            });
            expect(published).toHaveBeenCalledTimes(1);
            expect(published).toHaveBeenCalledWith({
              agentId: actor.agentId,
              usageUpdatedAt: expect.any(Number),
            });
            actor.assertCurrent();
            verified.resolve();
            await finish.promise;
          })
          .catch((error: unknown) => {
            verified.reject(error);
            throw error;
          });
        return job;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(Promise.all([projectionReady.promise, usageReady.promise]), signal);
    expect(sql.queries).toEqual([]);
    sql.restore();
    sql = undefined;
    closing = server.close({ reason: "incognito compute close proof" });
    await withinTest(joining.promise, signal);
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(() => actor.assertCurrent()).not.toThrow();
    // Other shutdown owners have settled; the scheduler now joins only this accepted work.
    sql = observeHostDataSql();
    release.resolve();
    await withinTest(verified.promise, signal);
    expect(sql.queries).toEqual([]);
    sql.restore();
    sql = undefined;
    finish.resolve();
    await closing;
    expect(() => actor.assertCurrent()).toThrow(IncognitoSessionEndedError);
  } finally {
    work.beginClose();
    vi.useRealTimers();
    prelude.resolve();
    release.resolve();
    finish.resolve();
    sql?.restore();
    unsubscribe?.();
    await Promise.allSettled([job, closing]);
    await work.drain();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
