import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type {
  SessionsForkResult,
  SessionsRewindResult,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntrySync,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as sessionController from "../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as agentExecution from "../state/openclaw-agent-execution.js";
import * as writeAdmission from "../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { readClosedDatabase, createTestGate } from "./server-close.lifecycle.test-support.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { terminalizeRestartSafeChatAdmission } from "./server-methods/chat-restart-recovery.js";
import type { GatewaySystemAgentSession } from "./server-methods/shared-types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import * as sessionObserverModel from "./session-observer-model.js";

type DatabaseExecution = ReturnType<typeof agentExecution.captureOpenClawAgentDatabaseExecution>;
type Kernel = Awaited<ReturnType<typeof createGatewayCloseRace>>["kernel"];
function createDispatch(
  kernel: Kernel,
  client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
) {
  const options = {
    client,
    context: kernel.gatewayRequestContext,
    methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
  };
  return <T>(method: string, params: unknown) =>
    dispatchGatewayRequestInProcess<T>(method, params, options);
}

const scope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:accepted-close-rewind",
  sessionId: "rewind-close-source",
};
async function seedTranscript(
  fixture: Awaited<ReturnType<typeof createGatewayMetadataCloseFixture>>,
) {
  replaceSessionEntrySync(scope, {
    sessionId: scope.sessionId,
    lifecycleRevision: "rewind-close-generation",
    updatedAt: 1,
  });
  const messages = [
    ["user-1", null, "user", "Retain this question."],
    ["assistant-1", "user-1", "assistant", "Retained answer."],
    ["user-2", "assistant-1", "user", "Edit this question."],
  ] as const;
  assert(
    replaceTranscriptEventsSync(scope, [
      createSessionTranscriptHeader({
        sessionId: scope.sessionId,
        cwd: fixture.state.workspaceDir,
      }),
      ...messages.map(([id, parentId, role, content]) => ({
        type: "message",
        id,
        parentId,
        message: { role, content },
      })),
    ]),
  );
  await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
  return openOpenClawAgentDatabase({ agentId: scope.agentId });
}

it("persists an accepted fork and queued rewind across the close prelude before retiring their database", async ({
  signal,
}) => {
  const race = await createGatewayCloseRace("gateway-session-rewind-close", signal);
  const { fixture, kernel } = race;
  const waitForGate = createTestGate(signal);
  const rewindQueued = createDeferred();
  let forking: Promise<SessionsForkResult> | undefined;
  let rewinding: Promise<SessionsRewindResult> | undefined;
  try {
    const database = await seedTranscript(fixture);
    const wrapExecution = (owner: DatabaseExecution): DatabaseExecution => ({
      ...owner,
      get fileIdentity() {
        return owner.fileIdentity;
      },
      runExisting: (source, operation, options) =>
        owner.runExisting(
          source,
          (worker) =>
            operation({
              execute: async (command, commandOptions) => {
                if (
                  command.type === "session.messageCut.commit" ||
                  command.type === "database.domain.publish"
                ) {
                  await race.block();
                }
                return await worker.execute(command, commandOptions);
              },
            }),
          options,
        ),
    });
    const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
    vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
      (...args) => wrapExecution(capture(...args)),
    );
    const capturePreparation = agentExecution.captureOpenClawAgentDatabasePreparationExecution;
    vi.spyOn(agentExecution, "captureOpenClawAgentDatabasePreparationExecution").mockImplementation(
      (...args) => wrapExecution(capturePreparation(...args)),
    );
    const dispatch = createDispatch(kernel);
    const params = { sessionKey: scope.sessionKey, entryId: "user-2" };
    forking = dispatch<SessionsForkResult>("sessions.fork", params);
    await race.waitForEntry(forking, "Fork settled before its accepted persistence could be held");
    const mutate = sessionController.runSessionMutation;
    vi.spyOn(sessionController, "runSessionMutation").mockImplementation(
      <T>(mutationParams: Parameters<typeof mutate<T>>[0]): Promise<T> => {
        const pending = mutate(mutationParams);
        rewindQueued.resolve();
        return pending;
      },
    );
    rewinding = dispatch<SessionsRewindResult>("sessions.rewind", params);
    await waitForGate(
      rewindQueued.promise,
      rewinding,
      "Rewind settled before entering the lifecycle queue",
    );
    await race.close(undefined, undefined, { reason: "session rewind close regression" });
    expect([kernel.scheduler.signal.aborted, race.closed, database.db.isOpen]).toEqual([
      true,
      false,
      true,
    ]);
    await expect(dispatch("sessions.rewind", params)).rejects.toThrow(
      "Gateway request entry is closed",
    );

    const [fork, result] = (await race.finish(Promise.all([forking, rewinding])))!;
    expect(fork).toMatchObject({
      editorText: "Edit this question.",
      sessionKey: expect.any(String),
    });
    expect(result).toEqual({ editorText: "Edit this question." });
    expect(database.db.isOpen).toBe(false);
    using reopened = new DatabaseSync(database.path, { readOnly: true });
    const activeEvents = reopened.prepare(
      "SELECT identity.event_id FROM session_transcript_active_events active JOIN transcript_event_identities identity ON identity.session_id = active.session_id AND identity.seq = active.event_seq WHERE active.session_id = ? AND active.message_position IS NOT NULL ORDER BY active.message_position",
    );
    const retainedEvents = [{ event_id: "user-1" }, { event_id: "assistant-1" }];
    const row = reopened
      .prepare(
        "SELECT current_session_id AS session_id, json_extract(entry_json, '$.previousSessionId') AS previous_session_id FROM session_nodes WHERE session_key = ?",
      )
      .get(scope.sessionKey);
    const child = reopened
      .prepare("SELECT current_session_id AS session_id FROM session_nodes WHERE session_key = ?")
      .get(fork.sessionKey);
    assert(typeof child?.session_id === "string");
    expect(child.session_id).not.toBe(scope.sessionId);
    expect(child.session_id).not.toBe(row?.session_id);
    expect(activeEvents.all(child.session_id)).toEqual(retainedEvents);
    assert(typeof row?.session_id === "string");
    expect(row.session_id).not.toBe(scope.sessionId);
    expect(row.previous_session_id).toBe(scope.sessionId);
    expect(activeEvents.all(row.session_id)).toEqual(retainedEvents);
  } finally {
    race.onCleanup(async () => {
      await Promise.allSettled([forking, rewinding]);
      vi.restoreAllMocks();
    });
    await race.dispose();
  }
});

it("drains an accepted observer digest before closing its database", async ({ signal }) => {
  const race = await createGatewayCloseRace("gateway-session-observer-close", signal);
  const { fixture, kernel } = race;
  const disposalEntered = new AbortController();
  let handling: Promise<void> | undefined;
  let persisting: Promise<boolean | null> | undefined;
  let removeClient: (() => void) | undefined;
  try {
    const context = kernel.resolvePluginGatewayContext();
    assert(context, "Gateway context");
    const observer = context.sessionObserver;
    assert(observer, "Session observer");
    const sessionKey = "agent:main:observer-close";
    const sessionId = "observer-close-session";
    const runId = "observer-close-run";
    const headline = "Accepted before shutdown";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, lifecycleRevision: "observer-close-generation", updatedAt: 1 },
    );
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const { client } = makeClient("observer-close-client", "operator", ["operator.read"]);
    kernel.clients.add(client);
    removeClient = () => void kernel.clients.delete(client);
    const subscription = context.subscribeSessionMessageEvents(client.connId, sessionKey, {
      provisional: true,
    });
    assert(subscription, "Observer subscription admitted for the active connection");
    subscription.commit();
    observer.setConnectionVisibility(client.connId, true);

    const persist = sessionObserverModel.defaultPersistDigest;
    let settledBeforeDatabaseClose = false;
    vi.spyOn(sessionObserverModel, "defaultPersistDigest").mockImplementation((params) => {
      if (params.sessionKey !== sessionKey) {
        return persist(params);
      }
      persisting = (async () => {
        await race.block();
        const result = await persist(params);
        settledBeforeDatabaseClose = agent.db.isOpen;
        return result;
      })();
      return persisting;
    });
    const event = {
      runId,
      sessionId,
      sessionKey,
      agentId: "main",
      seq: 1,
      ts: 1_000,
      stream: "item",
      data: { kind: "preamble", progressText: headline },
    };
    handling = observer.handleEventAsync(event);
    await race.waitForEntry(handling, "Observer skipped digest persistence");
    await withinTest(handling, signal);
    const dispose = observer.disposeAsync.bind(observer);
    vi.spyOn(observer, "disposeAsync").mockImplementation(() => {
      const pending = dispose();
      disposalEntered.abort();
      return pending;
    });
    await race.close(disposalEntered.signal, undefined, {
      reason: "session observer close regression",
    });
    expect([
      kernel.scheduler.signal.aborted,
      kernel.connectionWork.signal.aborted,
      race.closed,
      agent.db.isOpen,
    ]).toEqual([true, true, false, true]);
    await expect(
      observer.handleEventAsync({
        ...event,
        seq: 2,
        data: { kind: "preamble", progressText: "Refused after shutdown" },
      }),
    ).rejects.toThrow("Session observer is closed");

    const accepted = await race.finish(persisting);
    expect([accepted, settledBeforeDatabaseClose, agent.db.isOpen]).toEqual([true, true, false]);
    const [row] = readClosedDatabase(
      agent.path,
      "SELECT json_extract(entry_json, '$.observerDigest') AS digest FROM session_nodes WHERE session_key = ?",
      sessionKey,
    );
    expect(JSON.parse(String(row?.digest))).toMatchObject({ headline, runId, revision: 1 });
  } finally {
    race.onCleanup(async () => {
      await Promise.allSettled([handling, persisting]);
      vi.restoreAllMocks();
      removeClient?.();
    });
    await race.dispose();
  }
});

it("settles an accepted system-agent turn before Gateway close retires its audit database", async ({
  signal,
}) => {
  const gate = createTestGate(signal);
  const fixture = await createGatewayMetadataCloseFixture("gateway-system-agent-audit-close");
  const recordingEntered = createDeferred();
  const releaseRecording = createDeferred();
  const preludeEntered = createDeferred();
  let closing: Promise<void> | undefined;
  let turning: Promise<unknown> | undefined;
  try {
    fixture.config.agents = {
      ...fixture.config.agents,
      defaults: { ...fixture.config.agents?.defaults, model: "openai/gpt-5.5" },
    };
    const { server, kernel } = await fixture.startServer();
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const sessionId = "accepted-system-agent-turn";
    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    const engine: GatewaySystemAgentSession["engine"] = {
      handle: async (message) => {
        history.push(
          { role: "user", text: message },
          { role: "assistant", text: "Accepted answer" },
        );
        return { text: "Accepted answer", action: "none" };
      },
      answerWizard: async () => ({ text: "", action: "none" }),
      cancelWizard: async () => ({ text: "", action: "none" }),
      decorateRejoinReply: (reply) => reply,
      noteAssistantMessage: (text) => void history.push({ role: "assistant", text }),
      seedHistory: (turns) => void history.push(...turns),
      historyLength: () => history.length,
      historySince: (index) => history.slice(index),
      getPendingOperatorProposal: () => null,
      resolveOperatorApproval: async () => null,
      dispose: async () => undefined,
    };
    const client = {
      ...createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
      connId: "system-agent-close-client",
    };
    kernel.gatewayRequestContext.systemAgentSessions.set(sessionId, {
      engine,
      welcome: "Synthetic welcome",
      lastUsedAt: Date.now(),
      ownerKey: `connection:${client.connId}`,
    });
    probe.command(stateWorker, async (command, executeOptions, workerScope) => {
      if (command.type === "diagnostic.register") {
        recordingEntered.resolve();
        await releaseRecording.promise;
      }
      return workerScope.execute(command, executeOptions);
    });
    const dispatch = createDispatch(kernel, client);
    const chat = (message: string) => dispatch("openclaw.chat", { sessionId, message });
    turning = chat("Accepted question");
    // Shutdown may revoke the reply; the accepted logbook still has to settle.
    void turning.catch(() => undefined);
    await gate(recordingEntered.promise, turning, "Turn skipped audit persistence");
    kernel.scheduler.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    const closed = vi.fn<() => void>();
    closing = server.close({ reason: "system-agent audit close regression" }).then(closed);
    await gate(preludeEntered.promise, closing, "Gateway skipped its close prelude");
    expect(closed).not.toHaveBeenCalled();
    expect(shared.isOpen).toBe(true);
    await expect(chat("Too late")).rejects.toThrow("Gateway request entry is closed");
    releaseRecording.resolve();
    await withinTest(Promise.all([turning.catch(() => undefined), closing]), signal);
    expect(shared.isOpen).toBe(false);
    const rows = readClosedDatabase(
      resolveOpenClawStateSqlitePath(fixture.state.env),
      "SELECT payload_json FROM diagnostic_events WHERE scope = 'system-agent-transcript' ORDER BY sequence",
    );
    expect(rows.map((row) => JSON.parse(String(row.payload_json)))).toEqual([
      { role: "user", text: "Accepted question", at: expect.any(Number) },
      { role: "assistant", text: "Accepted answer", at: expect.any(Number) },
    ]);
  } finally {
    releaseRecording.resolve();
    await Promise.allSettled([turning, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});

it("joins accepted restart-safe terminal persistence after the real close prelude cancels its caller", async ({
  signal,
}) => {
  const gate = createTestGate(signal);
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
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  const settlementAuthority = new AbortController();
  try {
    const { server, kernel } = await fixture.startServer();
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
    await gate(accepted.promise, job, "Terminal persistence skipped admission");
    closing = server.close({ reason: "restart-safe terminal close proof" });
    await gate(joining.promise, closing, "Gateway skipped scheduler settlement");
    expect(kernel.scheduler.signal.aborted).toBe(true);
    const late = vi.fn();
    await kernel.scheduler.schedule({ id: "late-terminal-work", delayMs: 0, run: late }).stop();
    expect(late).not.toHaveBeenCalled();
    sql = observeHostDataSql();
    release.resolve();
    expect(await gate(settled.promise, job, "Terminal persistence did not settle")).toBe(true);
    expect(sql.queries).toEqual([]);
    settlementAuthority.abort(new Error("Terminal settlement completed"));
    sql.restore();
    sql = undefined;
    const rows = readClosedDatabase(
      target.storePath,
      `SELECT status, json_extract(entry_json, '$.lastRunId') AS lastRunId,
            json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS claim
           FROM session_nodes WHERE session_key = ?`,
      target.sessionKey,
    );
    expect(rows).toEqual([{ status: "killed", lastRunId: "close-run", claim: null }]);
    finish.resolve();
    await withinTest(closing, signal);
  } finally {
    work.beginClose();
    vi.useRealTimers();
    release.resolve();
    finish.resolve();
    sql?.restore();
    await Promise.allSettled([job, closing]);
    settlementAuthority.abort(new Error("Terminal fixture closed"));
    await work.drain();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
