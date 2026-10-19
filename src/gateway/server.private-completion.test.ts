// Real Gateway admission and SQLite receipts with a controlled agent command.
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent.js";
import { resolveAgentRunErrorLifecycleFields } from "../agents/run-termination.js";
import { runAnnounceAgentCall } from "../agents/subagents/announce/subagent-announce-completion-delivery.js";
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
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
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
  const completions = () =>
    database()
      .db.prepare("SELECT * FROM session_input_completions WHERE session_id = ?")
      .all(sessionId);
  const pending = () =>
    database()
      .db.prepare("SELECT * FROM session_pending_inputs WHERE session_id = ?")
      .all(sessionId);
  const transcript = () => sessionAccessor.loadTranscriptEventsSync(scope());
  const request = (message?: string) =>
    createPrivateCompletionRequest({ sessionKey, sessionId, runId, message });
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
  const recorder = (input: unknown) => readPrivateCompletionRecorder(input, sessionId);

  registerSessionsSendPrivateCompletionTests(() => ({
    context: kernel.gatewayRequestContext,
    sequence,
    sessionKey,
    sessionId,
    completions,
    pending,
    transcript,
    recorder,
    agentCommandMock,
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
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            terminal,
            "Successor terminated before reaching the real runner's embedded-agent boundary",
          ),
          signal,
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
    return {
      payloads: [],
      meta: { durationMs: 1, terminalReply: { disposition: "silent" } },
    } satisfies EmbeddedAgentRunResult;
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
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => kernel.gatewayRequestContext,
        },
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
      return { payloads: [], meta: { durationMs: 1, terminalReply: { disposition: "empty" } } };
    });
    try {
      const result = await runAnnounceAgentCall({
        agentParams: {
          ...request(),
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "subagent_settle",
            sourceSessionKey: sourceSessionKeys[0],
          },
        },
        privateCompletion: true,
        replyExpectation: "optional",
        expectFinal: true,
        settleWakeSourceSessionKeys: sourceSessionKeys,
        delegatedToolPolicyHandoff: {
          sourceSessionKey: sourceSessionKeys[0],
          targetSessionKey: sessionKey,
          targetSessionId: sessionId,
          idempotencyKey: runId,
          settleBatch: { sourceSessionKeys, isCurrent: () => true },
        },
        isExecutionAllowed: () => true,
        resolveGatewayContext: () => kernel.gatewayRequestContext,
      });
      expect(result).toMatchObject({ status: "ok", inputProcessingCompleted: true });
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
        expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
        expect(agentCommandMock).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["handled-hook", "yielded", "operator-stop"] as const)(
    "does not repeat settled parent work after restart before child delivery save (%s)",
    async (kind) => {
      const entered = createDeferred();
      const release = createDeferred();
      const stopped = kind === "operator-stop";
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        const inputRecorder = stopped
          ? expectDefined(command.userTurnTranscriptRecorder, "private input recorder")
          : recorder(input);
        expect(completions()).toEqual([]);
        expect(pending()).toMatchObject([{ run_id: runId }]);
        if (stopped) {
          command.abortSignal?.addEventListener("abort", () => release.resolve(), { once: true });
          entered.resolve();
          await release.promise;
          command.abortSignal?.throwIfAborted();
          throw new Error("Operator Stop must cancel this input before processing");
        }
        if (kind !== "handled-hook") {
          expect(await inputRecorder.persistApproved()).toMatchObject({ appended: true });
        }
        return {
          payloads: [],
          meta: { durationMs: 1, ...(kind === "yielded" ? { yielded: true } : {}) },
        };
      });
      if (stopped) {
        const processing = dispatch();
        const observed = processing.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          await entered.promise;
          expect(
            await dispatchGatewayMethodInProcess(
              "chat.abort",
              { runId, sessionKey },
              {
                forceSyntheticClient: true,
                operatorRoleActor: { kind: "system" },
                resolveGatewayContext: () => kernel.gatewayRequestContext,
              },
            ),
          ).toMatchObject({ aborted: true });
        } finally {
          release.resolve();
          await observed;
        }
        expect(await observed).toMatchObject({ value: { status: "timeout", stopReason: "rpc" } });
      } else {
        expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      }
      const replay = stopped
        ? { status: "error", stopReason: "rpc" }
        : { status: "ok", inputProcessingCompleted: true };
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
      const observation = runAnnounceAgentCall({
        agentParams: request(),
        privateCompletion: true,
        expectFinal: true,
        signal,
        isExecutionAllowed: () => allowed,
        resolveGatewayContext: () => kernel.gatewayRequestContext,
      });
      const observed = expect(observation).rejects.toThrow(
        cause === "source changed"
          ? "subagent source lifecycle changed before completion delivery"
          : "synthetic provider failure",
      );
      await entered.promise;
      const active = expectDefined(source(runId), "private source");
      allowed = cause !== "source changed";
      release.resolve();
      await observed;
      await active.input.settlement.promise;
      expect(
        await waitForChatAbortControllerRemoval({
          targets: [{ runId, entry: active }],
          timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      expect(source(runId)).toBeUndefined();
      const cancelled = cause === "source changed";
      expect(processingCount).toBe(cancelled ? 0 : 1);
      const failedNotice = transcript().some((event) =>
        JSON.stringify(event).includes("run-failed-before-reply"),
      );
      expect.soft(failedNotice).toBe(!cancelled);
      const session = (await loadSessionEntryAsync(sessionKey)).entry;
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
      return { payloads: [], meta: { durationMs: 1, terminalReply: { disposition: "silent" } } };
    });
    expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
    expect(processingCount).toBe(1);
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(transcript()).toEqual(before);
    expect(pending()).toEqual([]);
  });

  it("publishes a failed final when the required receipt write fails, then permits retry", async () => {
    ensureSessionInputCompletionsSchema(database().db);
    const refusal = refusePendingInputCommit({
      operation: "complete",
      message: "synthetic receipt write unavailable",
      sessionId,
      runId,
    });
    agentCommandMock.mockImplementation(processPrivateInput);
    try {
      let acceptedSource: RpcSourceRef | undefined;
      await expect(
        dispatch(undefined, () => {
          acceptedSource = source(runId);
        }),
      ).rejects.toThrow("synthetic receipt write unavailable");
      const active = expectDefined(acceptedSource, "accepted private receipt source");
      await active.input.settlement.promise;
      expect(source(runId)).toBeUndefined();

      expect(kernel.gatewayRequestContext.dedupe.get(`agent:${runId}`)).toMatchObject({
        ok: false,
        payload: { status: "error" },
      });
      expect(completions()).toEqual([]);
    } finally {
      refusal.mockRestore();
    }
    expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(completions()).toMatchObject([{ succeeded: 1 }]);
  });

  it("retries a private queue timeout and settles processing without caller-thread pending-input writes", async ({
    signal,
  }) => {
    const hostSql = observeHostDataSql();
    const staged = createDeferred();
    const releaseStaging = createDeferred();
    const stagePendingInput = pendingInputs.stageSessionPendingInput;
    const staging = vi
      .spyOn(pendingInputs, "stageSessionPendingInput")
      .mockImplementationOnce(async (...args) => {
        const receipt = await stagePendingInput(...args);
        staged.resolve();
        await releaseStaging.promise;
        return receipt;
      });
    const aborted: Array<{ runId: string; entry: RpcSourceRef }> = [];
    let queued: ReturnType<typeof dispatch> | undefined;
    try {
      queued = dispatch();
      await withinTest(
        awaitGateBeforeSettlement(
          staged.promise,
          queued,
          "Private input completed before reaching its pending-input staging boundary",
        ),
        signal,
      );
      aborted.push({
        runId,
        entry: expectDefined(source(runId), "Expected the queued run's cancellation owner"),
      });
      expect(
        chatAbort.abortChatRunById(kernel.gatewayRequestContext, {
          runId,
          sessionKey,
          expectedEntry: expectDefined(source(runId), "private source"),
          stopReason: "timeout",
        }).aborted,
      ).toBe(true);
      releaseStaging.resolve();
      const timedOut = await queued;
      expect(timedOut).toMatchObject({ status: "timeout", stopReason: "timeout" });
      expect(
        await waitForChatAbortControllerRemoval({
          targets: aborted,
          timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(pending()).toMatchObject([{ state: "interrupted" }]);
      agentCommandMock.mockImplementationOnce(processPrivateInput);
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(pending()).toEqual([]);
      expect(
        hostSql.queries.filter((sql) =>
          /^\s*(?:insert|update|delete|replace)\b.*\b(?:session_pending_inputs|session_input_completions)\b/is.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      releaseStaging.resolve();
      await Promise.allSettled(queued ? [queued] : []);
      staging.mockRestore();
      hostSql.restore();
    }
  });

  it.for(["processed", "cancelled"] as const)(
    "keeps delayed private admission %s after the announcement wait expires",
    async (outcome, { signal }) => {
      const held = createDeferred();
      const release = createDeferred();
      const caller = new AbortController();
      const mutation = withPluginRuntimeGatewayContextResolver(resolveGatewayContext(), () =>
        runSessionMutation({
          scope: storePath,
          identities: [sessionKey, sessionId],
          run: async () => {
            held.resolve();
            await release.promise;
          },
        }),
      );
      await held.promise;
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
        await withinTest(
          awaitGateBeforeSettlement(
            sourceRegistered.promise,
            observation,
            "Announcement settled before its controller source was registered",
          ),
          signal,
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
        release.resolve();
        await mutation;
        await joinRequests();
        expect(completions()).toMatchObject([
          { run_id: runId, succeeded: outcome === "processed" ? 1 : 0 },
        ]);
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
        vi.useRealTimers();
        release.resolve();
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

  it.each(["admission", "queued-abort"] as const)(
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

      try {
        await expect(
          dispatch(
            undefined,
            phase === "queued-abort"
              ? () => {
                  aborted.push({
                    runId,
                    entry: expectDefined(
                      source(runId),
                      "Expected the accepted run's cancellation owner",
                    ),
                  });
                  chatAbort.abortChatRunById(kernel.gatewayRequestContext, {
                    runId,
                    sessionKey,
                    expectedEntry: expectDefined(source(runId), "private source"),
                    stopReason: "timeout",
                  });
                }
              : undefined,
          ),
        ).rejects.toThrow("synthetic private transaction failure");
        expect(
          await waitForChatAbortControllerRemoval({
            targets: aborted,
            timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
          }),
        ).toBe(true);
        expect(source(runId)).toBeUndefined();
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(completions()).toEqual([]);
        if (phase === "admission") {
          expect(pending()).toEqual([]);
        } else {
          expect(pending()).toMatchObject([{ state: "interrupted" }]);
        }
      } finally {
        refusal.mockRestore();
      }
      agentCommandMock.mockImplementationOnce(processPrivateInput);
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledOnce();
    },
  );

  registerPrivateCompletionStopTests(() => ({
    kernel,
    sequence,
    sessionKey,
    sessionId,
    runId,
    storePath,
    recorder,
    dispatch,
    completions,
    pending,
    restart,
    source,
    agentCommandMock,
  }));
});
