// Real Gateway admission and SQLite receipts with a controlled agent command.
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { resolveAgentRunErrorLifecycleFields } from "../agents/run-termination.js";
import { runAnnounceAgentCall } from "../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { listRunsForControllerFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  createCanonicalSubagentRunFixture,
  settleSubagentRegistryPersistenceWork,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  releaseSubagentRun,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { captureRuntimeConfigAsyncReader, writeConfigFile } from "../config/config.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as pendingInputs from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  getCurrentSessionControllerOwner,
  captureSessionControllerSettlement,
  runSessionMutation,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { listRpcSourceEntries } from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../state/openclaw-agent-pending-inputs-schema.js";
import { setAbortedAgentDedupeEntries } from "./agent-turn/agent-dedupe.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import * as chatAbort from "./chat-abort.js";
import { refusePendingInputCommit } from "./pending-input-commit.test-support.js";
import { createTestGate } from "./server-close.lifecycle.test-support.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  createPrivateCompletionRequest,
  readPrivateCompletionRecorder,
  registerSessionsSendPrivateCompletionTests,
} from "./server.private-completion.sessions-send.test-support.js";
import { registerPrivateCompletionStopTests } from "./server.private-completion.stop.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import { captureRpcSourceScopeMatcher } from "./session-runtime-scope.js";
import {
  agentCommandMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  onceMessage,
  rpcReq,
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
    const config = await captureRuntimeConfigAsyncReader()();
    await writeConfigFile({
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: {
          ...config.gateway?.controlUi,
          allowedOrigins: ["http://private-completion.test"],
        },
      },
    });
    kernel = await captureGatewayKernel(async () => {
      harness = await startGatewayServerHarness();
    });
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
  const resolveGatewayContext = () =>
    expectDefined(kernel.gatewayRequestContext.resolveGatewayContext, "Gateway owner");
  const source = (targetRunId = runId) => {
    const matchesScope = captureRpcSourceScopeMatcher({
      storePath,
      resolveGatewayContext: resolveGatewayContext(),
    });
    return listRpcSourceEntries().find(
      ([id, entry]) => id === targetRunId && matchesScope(entry),
    )?.[1];
  };
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const rows = (table: "session_input_completions" | "session_pending_inputs") =>
    database().db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(sessionId);
  const completions = () => rows("session_input_completions");
  const pending = () => rows("session_pending_inputs");
  const transcript = () => sessionAccessor.loadTranscriptEventsSync(scope());
  const request = (message?: string) =>
    createPrivateCompletionRequest({ sessionKey, sessionId, runId, message });
  const gatewayContext = () => kernel.gatewayRequestContext;
  const rpcOptions = () => ({
    forceSyntheticClient: true,
    operatorRoleActor: { kind: "system" as const },
    resolveGatewayContext: gatewayContext,
  });
  const dispatchInput = (params: ReturnType<typeof request>, onAccepted?: () => void) =>
    dispatchGatewayMethodInProcess<Record<string, unknown>>("agent", params, {
      ...rpcOptions(),
      privateCompletion: true,
      expectFinal: true,
      onAccepted,
    });
  const dispatch = (message?: string, onAccepted?: () => void) =>
    dispatchInput(request(message), onAccepted);
  const announce = (overrides: Partial<Parameters<typeof runAnnounceAgentCall>[0]> = {}) =>
    runAnnounceAgentCall({
      agentParams: request(),
      privateCompletion: true,
      expectFinal: true,
      isExecutionAllowed: () => true,
      resolveGatewayContext: gatewayContext,
      ...overrides,
    });
  const processed = { status: "ok", inputProcessingCompleted: true };
  const completionOutcome = () => JSON.parse(String(completions()[0]?.outcome_json));
  const hasFailureNotice = () =>
    transcript().some((event) => JSON.stringify(event).includes("run-failed-before-reply"));
  const observe = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  async function expectDrained(targets: Array<{ runId: string; entry: RpcSourceRef }>) {
    expect(
      await waitForChatAbortControllerRemoval({
        targets,
        timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
      }),
    ).toBe(true);
  }
  const abortQueued = (targets: Array<{ runId: string; entry: RpcSourceRef }>) => {
    const entry = expectDefined(source(), "queued cancellation owner");
    targets.push({ runId, entry });
    return chatAbort.abortChatRunById(kernel.gatewayRequestContext, {
      runId,
      sessionKey,
      expectedEntry: entry,
      stopReason: "timeout",
    });
  };
  async function restart() {
    const previousDedupe = kernel.gatewayRequestContext.dedupe;
    await harness.close();
    closeOpenClawAgentDatabasesForTest();
    await start();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    expect(kernel.gatewayRequestContext.dedupe).not.toBe(previousDedupe);
  }
  const recorder = (input: unknown) => readPrivateCompletionRecorder(input, sessionId);
  const agentResult = (meta: Partial<EmbeddedAgentRunResult["meta"]> = {}) =>
    ({ payloads: [], meta: { durationMs: 1, ...meta } }) satisfies EmbeddedAgentRunResult;
  const expectProcessed = async (calls = 1) => {
    expect(await dispatch()).toMatchObject(processed);
    expect(agentCommandMock).toHaveBeenCalledTimes(calls);
  };

  const fixture = () => ({
    kernel,
    context: kernel.gatewayRequestContext,
    sequence,
    sessionKey,
    sessionId,
    runId,
    storePath,
    completions,
    pending,
    transcript,
    recorder,
    dispatch,
    restart,
    source,
    agentCommandMock,
  });
  registerSessionsSendPrivateCompletionTests(() => ({
    ...fixture(),
    verifyChatSuccessor: async (signal) => {
      const successorRunId = `chat-after-private-${sequence}`;
      const entered = createDeferred();
      const execution = vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async () => {
        entered.resolve();
        return { payloads: [{ text: "Synthetic successor answer" }], meta: { durationMs: 0 } };
      });
      gatewayReplyMock.mockImplementation(getReplyFromConfig);
      const { ws } = await harness.openClient({
        browserOrigin: "http://private-completion.test",
        client: {
          id: "openclaw-control-ui",
          version: "test",
          platform: "test",
          mode: "webchat",
        },
      });
      const terminal = onceMessage(
        ws,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === successorRunId &&
          ["final", "error", "aborted"].includes(String(frame.payload?.state)),
      );
      void terminal.catch(() => undefined);
      try {
        const acknowledged = await rpcReq(ws, "chat.send", {
          sessionKey,
          message: "Please answer after the retained child completion.",
          idempotencyKey: successorRunId,
        });
        expect(acknowledged).toMatchObject({
          ok: true,
          payload: { runId: successorRunId, status: "started" },
        });
        await createTestGate(signal)(
          entered.promise,
          terminal,
          "Successor terminated before reaching the real runner's embedded-agent boundary",
        );
        const final = await withinTest(terminal, signal);
        expect(final.payload?.state).toBe("final");
        await withinTest(
          withPluginRuntimeGatewayContextResolver(resolveGatewayContext(), () =>
            captureSessionControllerSettlement({
              scope: storePath,
              identities: [sessionKey, sessionId],
            }),
          ) ?? Promise.resolve(),
          signal,
        );
        expect(execution).toHaveBeenCalledOnce();
        expect(pending()).toEqual([]);
      } finally {
        ws.close();
        gatewayReplyMock.mockReset();
        execution.mockRestore();
      }
    },
  }));

  async function processPrivateInput(input: unknown) {
    await recorder(input).persistApproved();
    return agentResult({ terminalReply: { disposition: "silent" } });
  }

  it("keeps private completion streams and retained followups private before the next public turn", async () => {
    const { ws } = await harness.openClient({ scopes: ["operator.admin"] });
    onTestFinished(() => ws.close());
    expect((await rpcReq(ws, "sessions.messages.subscribe", { key: sessionKey })).ok).toBe(true);
    const frames: unknown[] = [];
    const followupDelivery: Array<boolean | undefined> = [];
    ws.on("message", (frame) => frames.push(JSON.parse(rawDataToString(frame))));
    const privateText = "Internal review note after the permitted message-tool update";
    const publicText = "The next ordinary answer is visible";
    agentCommandMock.mockImplementation(async (input) => {
      const command = input as AgentCommandOpts;
      await command.userTurnTranscriptRecorder?.persistApproved();
      await command.onExecutionStarted?.();
      const text = command.privateCompletion ? privateText : publicText;
      const currentRunId = expectDefined(command.runId, "Expected admitted run id");
      const operationalRunInstance = expectDefined(
        command.operationalRunInstance,
        "Expected admitted operational instance",
      );
      const followupTarget = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          receiptAuthority: () =>
            source(currentRunId)?.adapter.operationalRunInstance === operationalRunInstance &&
            !command.abortSignal?.aborted,
        },
        () => captureSessionEventTargetForHost("main", sessionKey),
      );
      followupDelivery.push(followupTarget.deliver);
      emitAgentEvent({ runId: currentRunId, stream: "lifecycle", data: { phase: "start" } });
      emitAgentEvent({
        runId: currentRunId,
        stream: "assistant",
        data: { text, delta: text },
      });
      emitAgentEvent({ runId: currentRunId, stream: "lifecycle", data: { phase: "end" } });
      return {
        payloads: [{ text, mediaUrl: null }],
        meta: { durationMs: 1, terminalReply: { disposition: "visible", text } },
      } satisfies Awaited<ReturnType<typeof agentCommandMock>>;
    });
    expect(await dispatch()).toMatchObject({ status: "ok" });
    const nextRunId = `ordinary-after-${runId}`;
    const visible = onceMessage(
      ws,
      (event) => event.type === "event" && JSON.stringify(event).includes(publicText),
    );
    expect(
      await dispatchGatewayMethodInProcess(
        "agent",
        {
          sessionKey,
          idempotencyKey: nextRunId,
          message: "What is the current result?",
          deliver: false,
        },
        { ...rpcOptions(), expectFinal: true },
      ),
    ).toMatchObject({ status: "ok" });
    await visible;
    expect(JSON.stringify(frames)).not.toContain(privateText);
    expect(followupDelivery).toEqual([false, undefined]);
  });

  it("binds a settle handoff to the source accepted by pending-input replay", async () => {
    const sourceSessionKeys = ["agent:main:subagent:first", "agent:main:subagent:second"] as const;
    const stage = pendingInputs.stageSessionPendingInput;
    const seed = vi
      .spyOn(pendingInputs, "stageSessionPendingInput")
      .mockImplementationOnce(async (target, options) => {
        const previous = expectDefined(
          await stage(target, {
            ...options,
            message: {
              ...options.message,
              provenance: {
                ...options.message.provenance,
                kind: "inter_session",
                sourceSessionKey: sourceSessionKeys[1],
              },
            },
          }),
          "Expected the interrupted scheduling sibling's input",
        );
        previous.finish("interrupted");
        await previous.settled?.();
        return await stage(target, options);
      });
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(command.inputProvenance?.sourceSessionKey).toBe(sourceSessionKeys[1]);
      expect(command.trustedInternalHandoff?.sourceSessionKey).toBe(sourceSessionKeys[1]);
      expect(command.replyExpectation).toBe("optional");
      await recorder(input).persistApproved();
      return agentResult({ terminalReply: { disposition: "empty" } });
    });
    try {
      const result = await announce({
        agentParams: {
          ...request(),
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "subagent_settle",
            sourceSessionKey: sourceSessionKeys[0],
          },
        },
        replyExpectation: "optional",
        settleWakeSourceSessionKeys: sourceSessionKeys,
        delegatedToolPolicyHandoff: {
          sourceSessionKey: sourceSessionKeys[0],
          targetSessionKey: sessionKey,
          targetSessionId: sessionId,
          idempotencyKey: runId,
          settleBatch: { sourceSessionKeys, isCurrent: () => true },
        },
      });
      expect(result).toMatchObject(processed);
      expect(agentCommandMock).toHaveBeenCalledOnce();
    } finally {
      seed.mockRestore();
    }
  });

  it.each(["rpc", "stop", "restart", "foreign-session"])(
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
      agentCommandMock.mockImplementationOnce(processPrivateInput);
      if (intentional) {
        expect(await dispatch()).toMatchObject({ status: "timeout", stopReason: reason });
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(pending()).toEqual([]);
        expect(completions()).toEqual([]);
        expect(await dispatch()).toMatchObject({ status: "timeout", stopReason: reason });
        expect(agentCommandMock).not.toHaveBeenCalled();
      } else {
        await expectProcessed();
      }
    },
  );

  it.each(["handled-hook", "yielded", "operator-stop"] as const)(
    "does not repeat settled parent work after restart before child delivery save (%s)",
    async (kind) => {
      const gate = createEnteredGate();
      const stopped = kind === "operator-stop";
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        const inputRecorder = stopped
          ? expectDefined(command.userTurnTranscriptRecorder, "private input recorder")
          : recorder(input);
        expect(completions()).toEqual([]);
        expect(pending()).toMatchObject([{ run_id: runId }]);
        if (stopped) {
          command.abortSignal?.addEventListener("abort", () => gate.release(), { once: true });
          await gate.wait();
          command.abortSignal?.throwIfAborted();
          throw new Error("Operator Stop must cancel this input before processing");
        }
        if (kind !== "handled-hook") {
          expect(await inputRecorder.persistApproved()).toMatchObject({ appended: true });
        }
        return agentResult(kind === "yielded" ? { yielded: true } : {});
      });
      if (stopped) {
        const observed = observe(dispatch());
        try {
          await gate.entered;
          expect(
            await dispatchGatewayMethodInProcess("chat.abort", { runId, sessionKey }, rpcOptions()),
          ).toMatchObject({ aborted: true });
        } finally {
          gate.release();
          await observed;
        }
        expect(await observed).toMatchObject({ value: { status: "timeout", stopReason: "rpc" } });
      } else {
        expect(await dispatch()).toMatchObject(processed);
      }
      const replay = stopped ? { status: "error", stopReason: "rpc" } : processed;
      expect(completions()).toMatchObject([{ run_id: runId, succeeded: stopped ? 0 : 1 }]);
      expect(pending()).toEqual([]);
      const committed = transcript();
      expect(JSON.stringify(committed).includes("Synthetic private child marker")).toBe(
        kind === "yielded",
      );
      expect(await dispatch()).toMatchObject(replay);
      // The subagent delivery owner has received no saved acknowledgement yet.
      // Its replay must reconcile from SQLite, not the old process's dedupe map.
      await restart();
      expect(await dispatch()).toMatchObject(replay);
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(transcript()).toEqual(committed);
      expect(pending()).toEqual([]);
      await expect(dispatch("changed child result")).rejects.toThrow("conflicts");
    },
  );

  it("preserves a paused owner when replaying a completed private settle input", async () => {
    const settleRequest = {
      ...request(),
      inputProvenance: {
        ...request().inputProvenance,
        sourceTool: "subagent_settle",
      },
    };
    const dispatchSettle = () => dispatchInput(settleRequest);
    agentCommandMock.mockImplementationOnce(async (input) => {
      await recorder(input).persistApproved();
      return agentResult();
    });
    expect(await dispatchSettle()).toMatchObject(processed);
    const completed = completions();
    expect(completed).toMatchObject([{ run_id: runId, succeeded: 1 }]);
    const committed = transcript();
    const previousRunId = `paused-after-${runId}`;
    const previous = createCanonicalSubagentRunFixture({
      runId: previousRunId,
      childSessionKey: sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "A later paused orchestration",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: Date.now(),
      pauseReason: "sessions_yield",
      expectsCompletionMessage: false,
    });
    await addSubagentRunForTests(previous);
    const paused = structuredClone(await getSubagentRunByChildSessionKey(sessionKey));
    const stored = listRunsForControllerFromRuns(
      loadSubagentRegistryFromSqlite(),
      "agent:main:main",
    );
    expect(paused).toMatchObject({ runId: previousRunId, pauseReason: "sessions_yield" });
    expect(stored.find((run) => run.runId === previousRunId)).toMatchObject({
      pauseReason: "sessions_yield",
    });
    // Evict only the transport replay: the actual completed SQLite input must
    // prevent this old delivery from adopting the target's newer paused run.
    kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
    try {
      expect(await dispatchSettle()).toMatchObject(processed);
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(await getSubagentRunByChildSessionKey(sessionKey)).toEqual(paused);
      expect(
        listRunsForControllerFromRuns(loadSubagentRegistryFromSqlite(), "agent:main:main"),
      ).toEqual(stored);
      expect(completions()).toEqual(completed);
      expect(transcript()).toEqual(committed);
      expect(pending()).toEqual([]);
    } finally {
      await releaseSubagentRun(previousRunId);
      await releaseSubagentRun(runId);
      await settleSubagentRegistryPersistenceWork();
    }
  });

  it.for(["source changed", "provider failed"] as const)(
    "settles private execution without confusing cancellation and failure: %s",
    async (cause, { signal }) => {
      const gate = createEnteredGate();
      let allowed = true;
      let processingCount = 0;
      signal.addEventListener("abort", () => gate.release(), { once: true });
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        await gate.wait();
        try {
          markReplyOperationExecutionStarted(
            expectDefined(getCurrentSessionControllerOwner(), "admitted command owner"),
          );
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
      const observation = announce({
        signal,
        isExecutionAllowed: () => allowed,
      });
      const observed = expect(observation).rejects.toThrow(
        cause === "source changed"
          ? "subagent source lifecycle changed before completion delivery"
          : "synthetic provider failure",
      );
      await gate.entered;
      const active = expectDefined(source(runId), "private source");
      allowed = cause !== "source changed";
      gate.release();
      await observed;
      await active.input.settlement.promise;
      await expectDrained([{ runId, entry: active }]);
      expect(source(runId)).toBeUndefined();
      const cancelled = cause === "source changed";
      expect(processingCount).toBe(cancelled ? 0 : 1);
      expect.soft(hasFailureNotice()).toBe(!cancelled);
      const session = (await loadSessionEntryAsync(sessionKey)).entry;
      expect.soft(session?.status === "failed").toBe(!cancelled);
      expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)).toMatchObject({
        ok: cancelled,
        payload: cancelled ? { status: "timeout", stopReason: "rpc" } : { status: "error" },
      });
      if (cancelled) {
        expect(completions()).toMatchObject([{ run_id: runId, succeeded: 0 }]);
        expect(completionOutcome()).toMatchObject({
          reason: "cancelled",
          stopReason: "rpc",
        });
        expect(pending()).toEqual([]);
        kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
        expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
        await restart();
        expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(hasFailureNotice()).toBe(false);
      } else {
        expect(completionOutcome()).toMatchObject({
          reason: "failed",
          error: "synthetic provider failure",
        });
      }
    },
  );

  it("resumes admitted but unprocessed input after a Gateway restart", async ({ signal }) => {
    const gate = createEnteredGate();
    let processingCount = 0;
    signal.addEventListener("abort", () => gate.release(), { once: true });
    agentCommandMock.mockImplementationOnce(async (input) => {
      const command = input as AgentCommandOpts;
      expect(await recorder(input).persistApproved()).toMatchObject({ appended: true });
      command.abortSignal!.addEventListener("abort", () => gate.release(), { once: true });
      await gate.wait();
      command.abortSignal!.throwIfAborted();
      throw new Error("restart must interrupt before private processing");
    });
    const observed = observe(dispatch());
    await gate.entered;
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
      return agentResult({ terminalReply: { disposition: "silent" } });
    });
    await expectProcessed(2);
    expect(processingCount).toBe(1);
    expect(transcript()).toEqual(before);
    expect(pending()).toEqual([]);
  });

  it("retries a private queue timeout and settles processing without caller-thread pending-input writes", async ({
    signal,
  }) => {
    const hostSql = observeHostDataSql();
    const gate = createEnteredGate();
    const stagePendingInput = pendingInputs.stageSessionPendingInput;
    const staging = vi
      .spyOn(pendingInputs, "stageSessionPendingInput")
      .mockImplementationOnce(async (...args) => {
        const receipt = await stagePendingInput(...args);
        await gate.wait();
        return receipt;
      });
    const aborted: Array<{ runId: string; entry: RpcSourceRef }> = [];
    let queued: ReturnType<typeof dispatch> | undefined;
    try {
      queued = dispatch();
      await createTestGate(signal)(
        gate.entered,
        queued,
        "Private input completed before reaching its pending-input staging boundary",
      );
      expect(abortQueued(aborted).aborted).toBe(true);
      gate.release();
      const timedOut = await queued;
      expect(timedOut).toMatchObject({ status: "timeout", stopReason: "timeout" });
      await expectDrained(aborted);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(pending()).toMatchObject([{ state: "interrupted" }]);
      agentCommandMock.mockImplementationOnce(processPrivateInput);
      await expectProcessed();
      expect(pending()).toEqual([]);
      expect(
        hostSql.queries.filter((sql) =>
          /^\s*(?:insert|update|delete|replace)\b.*\b(?:session_pending_inputs|session_input_completions)\b/is.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      gate.release();
      await Promise.allSettled(queued ? [queued] : []);
      staging.mockRestore();
      hostSql.restore();
    }
  });

  it.for(["processed", "cancelled"] as const)(
    "keeps delayed private admission %s after the announcement wait expires",
    async (outcome, { signal }) => {
      const gate = createEnteredGate();
      const caller = new AbortController();
      const mutation = withPluginRuntimeGatewayContextResolver(resolveGatewayContext(), () =>
        runSessionMutation({
          scope: storePath,
          identities: [sessionKey, sessionId],
          run: gate.wait,
        }),
      );
      await gate.entered;
      agentCommandMock.mockImplementationOnce(processPrivateInput);
      const sourceRegistered = createDeferred<RpcSourceRef>();
      const registerChatAbortController = chatAbort.registerChatAbortController;
      const sourceRegistration = vi
        .spyOn(chatAbort, "registerChatAbortController")
        .mockImplementation((params) => {
          const registration = registerChatAbortController(params);
          if (params.runId === runId && registration.entry) {
            sourceRegistered.resolve(registration.entry);
          }
          return registration;
        });
      const requests = vi.spyOn(kernel.gatewayRequestContext, "trackExecution");
      const joinRequests = async () => {
        let joined = 0;
        while (joined < requests.mock.results.length) {
          const batch = requests.mock.results.slice(joined);
          joined += batch.length;
          await Promise.allSettled(
            batch.flatMap((result) => (result.type === "return" ? [result.value] : [])),
          );
        }
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const observation = announce({
        timeoutMs: 200,
        signal: caller.signal,
      });
      const timedOut = expect(observation).rejects.toThrow("gateway request timeout for agent");
      try {
        await createTestGate(signal)(
          sourceRegistered.promise,
          observation,
          "Announcement settled before its controller source was registered",
        );
        await vi.advanceTimersByTimeAsync(200);
        vi.useRealTimers();
        await timedOut;
        expect(await dispatch()).toMatchObject({ status: "in_flight", admissionPending: true });
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(completions()).toEqual([]);
        if (outcome === "cancelled") {
          caller.abort(new Error("requester stopped"));
        }
        gate.release();
        await mutation;
        await joinRequests();
        expect(completions()).toMatchObject([
          { run_id: runId, succeeded: outcome === "processed" ? 1 : 0 },
        ]);
        if (outcome === "cancelled") {
          expect(completionOutcome()).toMatchObject({
            reason: "cancelled",
            stopReason: "rpc",
          });
          expect(agentCommandMock).not.toHaveBeenCalled();
          return;
        }
        await expectProcessed();
        expect(pending()).toEqual([]);
      } finally {
        vi.useRealTimers();
        gate.release();
        try {
          await Promise.allSettled([mutation, timedOut]);
          await joinRequests();
        } finally {
          requests.mockRestore();
          sourceRegistration.mockRestore();
        }
      }
    },
  );

  it.each(["admission", "queued-abort", "processed"] as const)(
    "publishes failure and retains retry when the worker commit refuses %s",
    async (phase) => {
      ensureSessionPendingInputsSchema(database().db);
      ensureSessionInputCompletionsSchema(database().db);
      const refusal = refusePendingInputCommit({
        operation: phase === "admission" ? "stage" : "complete",
        message: "synthetic private transaction failure",
        sessionId,
        runId,
      });
      const aborted: Array<{ runId: string; entry: RpcSourceRef }> = [];
      let acceptedSource: RpcSourceRef | undefined;
      if (phase === "processed") {
        agentCommandMock.mockImplementation(processPrivateInput);
      }
      try {
        await expect(
          dispatch(undefined, () => {
            if (phase === "queued-abort") {
              abortQueued(aborted);
            } else if (phase === "processed") {
              acceptedSource = source(runId);
            }
          }),
        ).rejects.toThrow("synthetic private transaction failure");
        if (phase === "processed") {
          await expectDefined(acceptedSource, "accepted private receipt source").input.settlement
            .promise;
        }
        await expectDrained(aborted);
        expect(source(runId)).toBeUndefined();
        if (phase === "processed") {
          expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)).toMatchObject({
            ok: false,
            payload: { status: "error" },
          });
        } else {
          expect(agentCommandMock).not.toHaveBeenCalled();
          if (phase === "admission") {
            expect(pending()).toEqual([]);
          } else {
            expect(pending()).toMatchObject([{ state: "interrupted" }]);
          }
        }
        expect(completions()).toEqual([]);
      } finally {
        refusal.mockRestore();
      }
      agentCommandMock.mockImplementationOnce(processPrivateInput);
      await expectProcessed(phase === "processed" ? 2 : 1);
      if (phase === "processed") {
        expect(completions()).toMatchObject([{ succeeded: 1 }]);
      }
    },
  );

  registerPrivateCompletionStopTests(fixture);
});
