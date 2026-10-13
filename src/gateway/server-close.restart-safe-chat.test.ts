import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import * as writeAdmission from "../state/openclaw-agent-write-admission.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { terminalizeRestartSafeChatAdmission } from "./server-methods/chat-restart-recovery.js";

it("joins accepted restart-safe terminal persistence after the real close prelude cancels its caller", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("restart-safe-terminal-close");
  const accepted = createDeferredCore();
  const release = createDeferredCore();
  const settled = createDeferredCore<boolean>();
  const finish = createDeferredCore();
  const joining = createDeferredCore();
  const work = new AsyncWorkScope();
  let job: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let callerSignal: AbortSignal | undefined;
  let observer: DatabaseSync | undefined;
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  const settlementAuthority = new AbortController();
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const target = {
      sessionKey: "agent:main:dashboard:restart-safe-terminal-close",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env }),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "close-session",
      updatedAt: 1_000,
      restartRecoveryDeliveryRunId: "close-run",
      restartRecoveryDeliverySourceRunId: "close-run",
    });
    const read = await readSessionEntriesFromStoreInWorker({
      agentId: "main",
      storePath: target.storePath,
      sessionKeys: [target.sessionKey],
      projection: "exact",
    });
    assert(read.source);
    const terminalTarget = {
      agentId: "main",
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
      readSource: read.source,
    };
    observer = new DatabaseSync(target.storePath, { readOnly: true });
    const write = writeAdmission.runOpenClawAgentWorkerWrite;
    let held = false;
    vi.spyOn(writeAdmission, "runOpenClawAgentWorkerWrite").mockImplementation(
      (options, run, timing, writerSignal) =>
        write(
          options,
          async () => {
            if (!("target" in options) && options.path === target.storePath && !held) {
              held = true;
              // The real FIFO and captured execution already own this write.
              accepted.resolve();
              await release.promise;
              expect(callerSignal?.aborted).toBe(true);
            }
            return run();
          },
          timing,
          writerSignal,
        ),
    );
    kernel.scheduler.signal.addEventListener(
      "abort",
      () => work.beginClose(kernel.scheduler.signal.reason),
      { once: true },
    );
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.resolve();
      return stop();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "restart-safe-terminal-settlement",
      delayMs: 0,
      run() {
        job = work.run(async () => {
          callerSignal = getAsyncWorkSignal();
          const result = await terminalizeRestartSafeChatAdmission({
            target: terminalTarget,
            expectedLifecycleRevision: read.entries[0]?.entry.lifecycleRevision,
            assertCurrent: () => settlementAuthority.signal.throwIfAborted(),
            admittedSessionId: "close-session",
            clientRunId: "close-run",
            startedAt: 1_000,
            status: "killed",
            retryable: false,
          });
          settled.resolve(result);
          await finish.promise;
        });
        return job;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    assert(job);
    await withinTest(
      awaitGateBeforeSettlement(accepted.promise, job, "Terminal persistence skipped admission"),
      signal,
    );
    closing = server.close({ reason: "restart-safe terminal close proof" });
    await withinTest(
      awaitGateBeforeSettlement(joining.promise, closing, "Gateway skipped scheduler settlement"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    const late = vi.fn();
    await kernel.scheduler.schedule({ id: "late-terminal-work", delayMs: 0, run: late }).stop();
    expect(late).not.toHaveBeenCalled();
    sql = observeHostDataSql();
    release.resolve();
    expect(
      await withinTest(
        awaitGateBeforeSettlement(
          settled.promise,
          job,
          "Accepted terminal persistence did not settle",
        ),
        signal,
      ),
    ).toBe(true);
    expect(sql.queries).toEqual([]);
    settlementAuthority.abort(new Error("Terminal settlement completed"));
    sql.restore();
    sql = undefined;
    expect(
      observer
        .prepare(
          `SELECT status, json_extract(entry_json, '$.lastRunId') AS lastRunId,
            json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS claim
           FROM session_nodes WHERE session_key = ?`,
        )
        .get(target.sessionKey),
    ).toEqual({ status: "killed", lastRunId: "close-run", claim: null });
    observer.close();
    observer = undefined;
    finish.resolve();
    await withinTest(closing, signal);
  } finally {
    work.beginClose();
    vi.useRealTimers();
    release.resolve();
    finish.resolve();
    sql?.restore();
    observer?.close();
    await Promise.allSettled([job, closing]);
    settlementAuthority.abort(new Error("Terminal fixture closed"));
    await work.drain();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
