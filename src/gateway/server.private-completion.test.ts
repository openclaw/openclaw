// Real Gateway admission and SQLite receipts with a controlled agent command.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { resolveAgentRunErrorLifecycleFields } from "../agents/run-termination.js";
import { runAnnounceAgentCall } from "../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import {
  writeSubagentSessionEntry,
  settleSubagentRegistryPersistenceWork,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRunsForControllerFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../state/openclaw-agent-pending-inputs-schema.js";
import { setAbortedAgentDedupeEntries } from "./agent-turn/agent-dedupe.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import { abortChatRunById } from "./chat-abort.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import { loadSessionEntry } from "./session-utils.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

describe("private subagent completion processing receipts", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  let sequence = 0;
  let sessionKey: string;
  let sessionId: string;
  let runId: string;
  let storePath: string;

  async function start() {
    const module = await import("./server-kernel.js");
    const create = module.createGatewayKernel;
    const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
      kernel = await create(...args);
      return kernel;
    });
    try {
      harness = await startGatewayServerHarness();
    } finally {
      capture.mockRestore();
    }
  }
  installGatewayTestHooks({ scope: "suite", setup: start, cleanup: async () => harness?.close() });
  beforeEach(async () => {
    sequence += 1;
    sessionKey = `agent:main:private-receipt-${sequence}`;
    sessionId = `private-parent-${sequence}`;
    runId = `announce:private-child-${sequence}`;
    storePath = path.join(
      process.env.OPENCLAW_STATE_DIR!,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    testState.sessionStorePath = storePath;
    await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } } });
    agentCommandMock.mockReset();
    await prepareGatewayReplyRuntimeForTest();
  });
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const completions = () =>
    database()
      .db.prepare("SELECT * FROM session_input_completions WHERE session_id = ?")
      .all(sessionId);
  const pending = () =>
    database()
      .db.prepare("SELECT * FROM session_pending_inputs WHERE session_id = ?")
      .all(sessionId);
  const transcript = () => loadTranscriptEventsSync(scope());
  const request = (message = "Synthetic private child marker") => ({
    sessionKey,
    expectedExistingSessionId: sessionId,
    idempotencyKey: runId,
    message,
    deliver: false,
    sourceReplyDeliveryMode: "automatic",
    inputProvenance: {
      kind: "inter_session",
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:main:subagent:synthetic-child",
    },
  });
  const dispatch = (message?: string, onAccepted?: () => void) =>
    dispatchGatewayMethodInProcess<Record<string, unknown>>("agent", request(message), {
      privateCompletion: true,
      expectFinal: true,
      forceSyntheticClient: true,
      onAccepted,
      operatorRoleActor: { kind: "system" },
      resolveGatewayContext: () => kernel.gatewayRequestContext,
    });
  async function restart() {
    const previousDedupe = kernel.gatewayRequestContext.dedupe;
    await harness.close();
    closeOpenClawAgentDatabasesForTest();
    await start();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    expect(kernel.gatewayRequestContext.dedupe).not.toBe(previousDedupe);
  }
  function recorder(input: unknown) {
    const command = input as AgentCommandOpts;
    expect(command.deliver).toBe(false);
    expect(command.sessionId).toBe(sessionId);
    return expectDefined(
      command.userTurnTranscriptRecorder,
      "Expected real private input recorder",
    );
  }

  it.each(["rpc", "stop", "timeout", "restart", "foreign-session"])(
    "preserves only a matching intentional pre-admission stop: %s",
    async (reason) => {
      const intentional = reason === "rpc" || reason === "stop";
      setAbortedAgentDedupeEntries({
        dedupe: kernel.gatewayRequestContext.dedupe,
        keys: [`agent:${runId}`],
        runId,
        agentId: "main",
        sessionKey: reason === "foreign-session" ? "agent:main:other-parent" : sessionKey,
        stopReason: reason === "foreign-session" ? "rpc" : reason,
      });
      agentCommandMock.mockImplementationOnce(async (input) => {
        await recorder(input).persistApproved();
        return { payloads: [{ text: "NO_REPLY", mediaUrl: null }], meta: { durationMs: 1 } };
      });
      if (intentional) {
        expect(await dispatch()).toMatchObject({ status: "timeout", stopReason: reason });
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(pending()).toEqual([]);
        expect(completions()).toEqual([]);
        expect(await dispatch()).toMatchObject({ status: "timeout", stopReason: reason });
        expect(agentCommandMock).not.toHaveBeenCalled();
      } else {
        expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
        expect(agentCommandMock).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["silent", "handled-hook", "yielded"] as const)(
    "does not repeat completed parent work after restart before child delivery save (%s)",
    async (kind) => {
      let processingCount = 0;
      agentCommandMock.mockImplementationOnce(async (input) => {
        const inputRecorder = recorder(input);
        expect(completions()).toEqual([]);
        expect(pending()).toMatchObject([{ run_id: runId }]);
        if (kind !== "handled-hook") {
          expect(await inputRecorder.persistApproved()).toMatchObject({ appended: true });
        }
        processingCount += 1;
        return {
          payloads: kind === "silent" ? [{ text: "NO_REPLY", mediaUrl: null }] : [],
          meta: { durationMs: 1, ...(kind === "yielded" ? { yielded: true } : {}) },
        };
      });
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(completions()).toMatchObject([{ run_id: runId, succeeded: 1 }]);
      expect(pending()).toEqual([]);
      const committed = transcript();
      expect(JSON.stringify(committed).includes("Synthetic private child marker")).toBe(
        kind !== "handled-hook",
      );
      // The subagent delivery owner has received no saved acknowledgement yet.
      // Its replay must reconcile from SQLite, not the old process's dedupe map.
      await restart();
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(processingCount).toBe(1);
      expect(transcript()).toEqual(committed);
      expect(pending()).toEqual([]);
      await expect(dispatch("changed child result")).rejects.toThrow("conflicts");
    },
  );

  it.for(["source changed", "provider failed"] as const)(
    "settles private execution without confusing cancellation and failure: %s",
    async (cause, { signal }) => {
      const entered = createDeferred();
      const release = createDeferred();
      let allowed = true;
      let processingCount = 0;
      signal.addEventListener("abort", () => release.resolve(), { once: true });
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        entered.resolve();
        await release.promise;
        try {
          await command.onExecutionStarted?.();
          processingCount += 1;
          throw new Error("synthetic provider failure");
        } catch (error) {
          // Exercise the real persisted lifecycle projection using the command's
          // error classification, not a mock that silently drops lifecycle errors.
          await lifecycleState.persistGatewaySessionLifecycleEvent({
            sessionKey,
            event: {
              runId,
              sessionId,
              ts: Date.now(),
              data: {
                phase: "error",
                error: error instanceof Error ? error.message : String(error),
                ...resolveAgentRunErrorLifecycleFields(error, command.abortSignal),
              },
            },
          });
          throw error;
        }
      });
      const observation = runAnnounceAgentCall({
        agentParams: request(),
        privateCompletion: true,
        expectFinal: true,
        isExecutionAllowed: () => allowed,
        resolveGatewayContext: () => kernel.gatewayRequestContext,
      });
      const observed = expect(observation).rejects.toThrow(
        cause === "source changed"
          ? "subagent source lifecycle changed before completion delivery"
          : "synthetic provider failure",
      );
      await entered.promise;
      allowed = cause !== "source changed";
      release.resolve();
      await observed;
      await expect
        .poll(() => kernel.gatewayRequestContext.chatAbortControllers.has(runId))
        .toBe(false);
      const cancelled = cause === "source changed";
      expect(processingCount).toBe(cancelled ? 0 : 1);
      const failedNotice = transcript().some((event) =>
        JSON.stringify(event).includes("run-failed-before-reply"),
      );
      expect.soft(failedNotice).toBe(!cancelled);
      const session = loadSessionEntry(sessionKey).entry;
      expect.soft(session?.status === "failed").toBe(!cancelled);
      expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)).toMatchObject({
        ok: cancelled,
        payload: cancelled ? { status: "timeout", stopReason: "rpc" } : { status: "error" },
      });
      if (cancelled) {
        expect(completions()).toMatchObject([{ run_id: runId, succeeded: 0 }]);
        expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
          reason: "cancelled",
          stopReason: "rpc",
        });
        expect(pending()).toEqual([]);
        kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
        expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
        await restart();
        expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(
          transcript().some((event) => JSON.stringify(event).includes("run-failed-before-reply")),
        ).toBe(false);
      } else {
        expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
          reason: "failed",
          error: "synthetic provider failure",
        });
      }
    },
  );

  it("resumes admitted but unprocessed input after a Gateway restart", async ({ signal }) => {
    const committed = createDeferred();
    const release = createDeferred();
    let processingCount = 0;
    signal.addEventListener("abort", () => release.resolve(), { once: true });
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(await recorder(input).persistApproved()).toMatchObject({ appended: true });
      committed.resolve();
      command.abortSignal!.addEventListener("abort", () => release.resolve(), { once: true });
      await release.promise;
      command.abortSignal!.throwIfAborted();
      throw new Error("restart must interrupt before private processing");
    });
    const interrupted = dispatch();
    const observed = interrupted.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await committed.promise;
    expect(completions()).toEqual([]);
    expect(processingCount).toBe(0);
    const before = transcript();
    await harness.server.close({
      reason: "gateway restart",
      restartExpectedMs: 0,
      drainTimeoutMs: 0,
    });
    await observed;
    closeOpenClawAgentDatabasesForTest();
    await start();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    agentCommandMock.mockImplementationOnce(async (input) => {
      await recorder(input).persistApproved();
      processingCount += 1;
      return { payloads: [{ text: "NO_REPLY", mediaUrl: null }], meta: { durationMs: 1 } };
    });
    expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
    expect(processingCount).toBe(1);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(transcript()).toEqual(before);
    expect(pending()).toEqual([]);
  });

  it("publishes a failed final when the required receipt write fails, then permits retry", async () => {
    ensureSessionInputCompletionsSchema(database().db);
    database().db.exec(
      "CREATE TRIGGER fail_private_receipt BEFORE INSERT ON session_input_completions BEGIN SELECT RAISE(ABORT, 'synthetic receipt write unavailable'); END",
    );
    agentCommandMock.mockImplementation(async (input) => {
      await recorder(input).persistApproved();
      return { payloads: [{ text: "NO_REPLY", mediaUrl: null }], meta: { durationMs: 1 } };
    });
    try {
      await expect(dispatch()).rejects.toThrow("synthetic receipt write unavailable");
      expect(kernel.gatewayRequestContext.chatAbortControllers.has(runId)).toBe(false);
      expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)).toMatchObject({
        ok: false,
        payload: { status: "error" },
      });
      expect(completions()).toEqual([]);
    } finally {
      database().db.exec("DROP TRIGGER fail_private_receipt");
    }
    expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(completions()).toMatchObject([{ succeeded: 1 }]);
  });

  it("retries a private queue timeout before transcript promotion", async () => {
    const timedOut = await dispatch(undefined, () => {
      expect(
        abortChatRunById(kernel.gatewayRequestContext, { runId, sessionKey, stopReason: "timeout" })
          .aborted,
      ).toBe(true);
    });
    expect(timedOut).toMatchObject({ status: "timeout", stopReason: "timeout" });
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(pending()).toMatchObject([{ state: "interrupted" }]);
    agentCommandMock.mockImplementationOnce(async (input) => {
      await recorder(input).persistApproved();
      return { payloads: [{ text: "NO_REPLY", mediaUrl: null }], meta: { durationMs: 1 } };
    });
    expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
    expect(agentCommandMock).toHaveBeenCalledOnce();
    expect(pending()).toEqual([]);
  });

  it.each(["processed", "cancelled"] as const)(
    "keeps delayed private admission %s after the announcement wait expires",
    async (outcome) => {
      const held = createDeferred();
      const release = createDeferred();
      const caller = new AbortController();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        run: async () => {
          held.resolve();
          await release.promise;
        },
      });
      await held.promise;
      agentCommandMock.mockImplementationOnce(async (input) => {
        await recorder(input).persistApproved();
        return { payloads: [{ text: "NO_REPLY", mediaUrl: null }], meta: { durationMs: 1 } };
      });
      const observation = runAnnounceAgentCall({
        agentParams: request(),
        privateCompletion: true,
        expectFinal: true,
        timeoutMs: 200,
        signal: caller.signal,
        isExecutionAllowed: () => true,
        resolveGatewayContext: () => kernel.gatewayRequestContext,
      });
      const timedOut = expect(observation).rejects.toThrow("gateway request timeout for agent");
      try {
        await timedOut;
        expect(await dispatch()).toMatchObject({ status: "in_flight", admissionPending: true });
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(completions()).toEqual([]);
        if (outcome === "cancelled") {
          caller.abort(new Error("requester stopped"));
        }
        release.resolve();
        await mutation;
        await expect
          .poll(() => completions())
          .toMatchObject([{ run_id: runId, succeeded: outcome === "processed" ? 1 : 0 }]);
        if (outcome === "cancelled") {
          expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
            reason: "cancelled",
            stopReason: "rpc",
          });
          expect(agentCommandMock).not.toHaveBeenCalled();
          return;
        }
        expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(pending()).toEqual([]);
      } finally {
        release.resolve();
        await mutation;
        await timedOut;
      }
    },
  );

  it.each(["admission", "queued-abort"] as const)(
    "publishes failure and retains retry when SQLite rejects %s",
    async (phase) => {
      ensureSessionPendingInputsSchema(database().db);
      ensureSessionInputCompletionsSchema(database().db);
      const table = phase === "admission" ? "session_pending_inputs" : "session_input_completions";
      database().db.exec(
        `CREATE TRIGGER fail_private_admission BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic private transaction failure'); END`,
      );
      try {
        await expect(
          dispatch(
            undefined,
            phase === "queued-abort"
              ? () => {
                  abortChatRunById(kernel.gatewayRequestContext, {
                    runId,
                    sessionKey,
                    stopReason: "timeout",
                  });
                }
              : undefined,
          ),
        ).rejects.toThrow("synthetic private transaction failure");
        expect(kernel.gatewayRequestContext.chatAbortControllers.has(runId)).toBe(false);
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(completions()).toEqual([]);
        if (phase === "admission") {
          expect(pending()).toEqual([]);
        } else {
          expect(pending()).toMatchObject([{ state: "interrupted" }]);
        }
      } finally {
        database().db.exec("DROP TRIGGER fail_private_admission");
      }
      agentCommandMock.mockImplementationOnce(async (input) => {
        await recorder(input).persistApproved();
        return { payloads: [{ text: "NO_REPLY", mediaUrl: null }], meta: { durationMs: 1 } };
      });
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledOnce();
    },
  );

  it("preserves an operator stop after private input consumption across retry and restart", async ({
    signal,
  }) => {
    const consumed = createDeferred();
    const release = createDeferred();
    signal.addEventListener("abort", () => release.resolve(), { once: true });
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      await command.onExecutionStarted?.();
      await recorder(input).persistApproved();
      consumed.resolve();
      command.abortSignal!.addEventListener("abort", () => release.resolve(), { once: true });
      await release.promise;
      command.abortSignal!.throwIfAborted();
      throw new Error("operator stop must prevent further work");
    });
    const first = dispatch();
    const observed = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await consumed.promise;
    const descendantRunId = `private-descendant-${sequence}`;
    const childSessionKey = `agent:main:subagent:${descendantRunId}`;
    const childSessionId = `${descendantRunId}-session`;
    const childStarted = createDeferred();
    const releaseChild = createDeferred();
    let childAbortSignal: AbortSignal | undefined;
    signal.addEventListener("abort", () => releaseChild.resolve(), { once: true });
    await writeSubagentSessionEntry({
      stateDir: process.env.OPENCLAW_STATE_DIR!,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: childSessionId,
    });
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(command.runId).toBe(descendantRunId);
      expect(command.sessionId).toBe(childSessionId);
      childAbortSignal = command.abortSignal;
      await command.onExecutionStarted?.();
      await command.userTurnTranscriptRecorder?.persistApproved();
      childStarted.resolve();
      command.abortSignal!.addEventListener("abort", () => releaseChild.resolve(), { once: true });
      await releaseChild.promise;
      command.abortSignal!.throwIfAborted();
      throw new Error("operator stop must interrupt the continuation child");
    });
    const child = dispatchGatewayMethodInProcess<Record<string, unknown>>(
      "agent",
      {
        sessionKey: childSessionKey,
        expectedExistingSessionId: childSessionId,
        idempotencyKey: descendantRunId,
        message: "Synthetic continuation child",
        deliver: false,
      },
      {
        expectFinal: true,
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        resolveGatewayContext: () => kernel.gatewayRequestContext,
      },
    );
    const observedChild = child.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const childWaitEntered = createDeferred();
    const waitForAgentJob = agentJobs.waitForAgentJob;
    const waitObservation = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
      const wait = waitForAgentJob(params);
      if (params.runId === descendantRunId) {
        childWaitEntered.resolve();
      }
      return wait;
    });
    // Cancellation must release the admission barrier so cleanup can join both producers.
    const releaseWaitAdmission = () => childWaitEntered.resolve();
    signal.addEventListener("abort", releaseWaitAdmission, { once: true });
    try {
      await Promise.race([
        childStarted.promise,
        observedChild.then(() => {
          throw new Error("continuation child finished before execution started");
        }),
      ]);
      registerSubagentRun({
        runId: descendantRunId,
        childSessionKey,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: runId,
        requesterDisplayKey: sessionKey,
        task: "synthetic continuation child",
        cleanup: "keep",
        expectsCompletionMessage: false,
        taskRowOwnership: "required",
      });
      // Keep both producers live until the child's registration and wait request
      // are admitted; a slow socket handshake must not hide the outstanding wait.
      await expect
        .poll(() =>
          loadSubagentRunsForControllerFromSqlite(sessionKey).some(
            (run) => run.runId === descendantRunId,
          ),
        )
        .toBe(true);
      signal.throwIfAborted();
      await childWaitEntered.promise;
      signal.throwIfAborted();
      expect(
        await kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
          sessionKey,
          runId,
        }),
      ).toMatchObject({ aborted: true });
      expect(childAbortSignal?.aborted).toBe(true);
    } finally {
      signal.removeEventListener("abort", releaseWaitAdmission);
      waitObservation.mockRestore();
      if (kernel.gatewayRequestContext.chatAbortControllers.has(runId)) {
        await kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
          sessionKey,
          runId,
        });
      }
      if (kernel.gatewayRequestContext.chatAbortControllers.has(descendantRunId)) {
        await kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
          sessionKey: childSessionKey,
          runId: descendantRunId,
        });
      }
      release.resolve();
      releaseChild.resolve();
      await Promise.all([observed, observedChild]);
    }
    await settleSubagentRegistryPersistenceWork();
    expect(await observedChild).toMatchObject({ value: { status: "timeout", stopReason: "rpc" } });
    expect(
      loadSubagentRunsForControllerFromSqlite(sessionKey).find(
        (run) => run.runId === descendantRunId,
      ),
    ).toMatchObject({ endedReason: "subagent-killed", execution: { status: "terminal" } });
    expect(completions()).toMatchObject([{ succeeded: 0 }]);
    expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
      reason: "cancelled",
      stopReason: "rpc",
    });
    expect(pending()).toEqual([]);
    expect(await observed).toMatchObject({ value: { status: "timeout", stopReason: "rpc" } });
    // Retire only this run's process projection to exercise the durable receipt.
    // Matching pre-admission Stop cache replay is covered separately above.
    kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
    expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
    await restart();
    expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
    expect(
      agentCommandMock.mock.calls.map(([input]) => {
        const command = input as AgentCommandOpts;
        return { runId: command.runId, sessionId: command.sessionId };
      }),
    ).toEqual([
      { runId, sessionId },
      { runId: descendantRunId, sessionId: childSessionId },
    ]);
  });
  it.each(["resolved", "rejected", "abandoned"] as const)(
    "preserves executing private timeout facts (%s)",
    async (kind) => {
      const consumed = createDeferred();
      const release = createDeferred();
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        await command.onExecutionStarted?.();
        const inputRecorder = recorder(input);
        await inputRecorder.persistApproved();
        inputRecorder.markSentToProvider?.();
        consumed.resolve();
        // Hold the producer after abort so lifecycle projection cannot stand
        // in for execution settlement; abandoned work also outlives the grace.
        await release.promise;
        if (kind === "rejected") {
          command.abortSignal!.throwIfAborted();
        }
        return {
          payloads: [],
          meta: {
            durationMs: 1,
            aborted: true,
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
          },
        };
      });
      const first = dispatch();
      const observed = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: String(error) }),
      );
      await consumed.promise;
      const active = expectDefined(
        kernel.gatewayRequestContext.chatAbortControllers.get(runId),
        "executing controller",
      );
      expect(active.executionStarted).toBe(true);
      const releaseTerminalWrite = createDeferred();
      let terminalWrite: Promise<void> | undefined;
      const persistLifecycle = lifecycleState.persistGatewaySessionLifecycleEvent;
      const delayedTerminalWrite =
        kind === "abandoned"
          ? vi
              .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
              .mockImplementation((params) => {
                if (params.event.runId !== runId) {
                  return persistLifecycle(params);
                }
                terminalWrite = releaseTerminalWrite.promise.then(() => persistLifecycle(params));
                return terminalWrite;
              })
          : undefined;
      active.expiresAtMs = Date.now() - 1;
      const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
      const { createGatewayMaintenanceStateForTest } =
        await import("./test-helpers.maintenance-state.js");
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const timers = startGatewayMaintenanceTimers({
        ...createGatewayMaintenanceStateForTest(),
        ...kernel.gatewayRequestContext,
        logHealth: { info: vi.fn(), error: vi.fn() },
        runWorktreeGc: async () => undefined,
        runDeliveryQueueMediaGc: async () => undefined,
        runManagedOutgoingMediaGc: async () => undefined,
      });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(active.controller.signal.aborted).toBe(true);
        expect(active.abortStopReason).toBe("timeout");
        expect(kernel.gatewayRequestContext.chatAbortControllers.get(runId)).toBe(active);
        expect(completions()).toEqual([]);
        if (kind === "abandoned") {
          // Keep the real terminal write pending through maintenance retirement.
          expect(terminalWrite).toBeInstanceOf(Promise);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(kernel.gatewayRequestContext.chatAbortControllers.has(runId)).toBe(false);
          expect(active.projectSessionTerminalPending).toBe(true);
          expect(active.projectSessionTerminalPersistence).toBe(terminalWrite);
          expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
            reason: "timed_out",
            status: "timeout",
            stopReason: "timeout",
          });
        }
      } finally {
        await timers.stopPeriodicTasks();
        await timers.skillUsageCleanup();
        vi.useRealTimers();
        releaseTerminalWrite.resolve();
        release.resolve();
        try {
          await terminalWrite;
        } finally {
          delayedTerminalWrite?.mockRestore();
        }
      }
      const response = await observed;
      const rows = completions();
      const outcome = JSON.parse(String(rows[0]?.outcome_json));
      expect(response).toMatchObject({ value: { status: "timeout", stopReason: "timeout" } });
      expect(outcome).toMatchObject({ status: "timeout", stopReason: "timeout" });
      expect(
        await waitForChatAbortControllerRemoval({
          entries: kernel.gatewayRequestContext.chatAbortControllers,
          targets: [{ runId, entry: active }],
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      expect(kernel.gatewayRequestContext.chatAbortControllers.has(runId)).toBe(false);
      if (kind === "resolved") {
        expect(outcome).toMatchObject({
          reason: "hard_timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        });
        expect(response).toMatchObject({
          value: { timeoutPhase: "provider", providerStarted: true },
        });
      } else {
        expect(outcome.reason).toBe("timed_out");
        expect(outcome.timeoutPhase).toBeUndefined();
        expect(outcome.providerStarted).toBeUndefined();
      }
      kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
      agentCommandMock.mockImplementationOnce(async (input) => {
        await recorder(input).persistApproved();
        return { payloads: [], meta: { durationMs: 1 } };
      });
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
    },
  );
});
