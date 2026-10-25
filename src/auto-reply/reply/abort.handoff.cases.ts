import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as subagentControlSession from "../../agents/subagents/registry/subagent-control-session.js";
import {
  addSubagentRunForTests,
  releaseSubagentRun,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig, type OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  publishSystemEventStoreConfig,
  resolvePhysicalSessionStorePath,
} from "../../config/sessions/session-store-path.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import {
  captureExecRequestOwners,
  withExecRequestTurn,
  type ExecRequestOwner,
} from "../../infra/exec-request-context.js";
import { captureSessionEntryCurrentCheckAsync } from "../../plugin-sdk/session-binding-runtime.js";
import { normalizeSessionDeliveryState } from "../../plugin-sdk/session-store-runtime.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { handleStopCommand } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";

type StopFixture = {
  cfg: OpenClawConfig;
  ctx: FinalizedRuntimeMsgContext;
  entry: SessionEntry;
  params: HandleCommandsParams;
  storePath: string;
  target: ReturnType<typeof captureSessionTarget>;
  isCommandTargetCurrent: NonNullable<
    NonNullable<HandleCommandsParams["opts"]>["isCommandTargetCurrent"]
  >;
};
export function registerAbortHandoffCases({
  pathKind,
  sessionKey,
  setupStop,
}: {
  pathKind: "fast" | "command";
  sessionKey: string;
  setupStop: () => Promise<StopFixture>;
}) {
  it.each([
    { waiting: false, abortable: true },
    { waiting: true, abortable: true },
    { waiting: true, abortable: false },
  ])(
    "reports a captured local wait only for accepted cancellation: %j",
    async ({ waiting, abortable }) => {
      const state = await setupStop();
      const runId = `cancel-wait-${pathKind}`;
      registerAgentRunContext(runId, { sessionKey, agentId: "main" });
      const context = expectDefined(getAgentRunContext(runId), "run context");
      context.localModelWait = waiting ? { requestId: "request-1" } : undefined;
      const operation = createReplyOperation({
        sessionKey,
        sessionId: state.entry.sessionId,
        target: state.target,
        agentId: "main",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        runId,
        cancel: () => {
          context.localModelWait = undefined;
          queueMicrotask(() => operation.complete());
        },
      });
      if (!abortable) {
        operation.freezeAbort();
      }
      try {
        const result =
          pathKind === "fast"
            ? await tryFastAbortFromMessage(state)
            : await handleStopCommand(state.params, true);
        const text =
          result && "handled" in result
            ? formatAbortReplyText(
                result.stoppedSubagents,
                result.rejectionReason,
                result.failedSubagents,
                result.localModelMayStillBeFinishing,
              )
            : result?.reply?.text;
        expect(text).toBe(
          abortable
            ? `⚙️ Agent was aborted.${waiting ? " Cancellation requested; the local model may still be finishing." : ""}`
            : "Agent reply is already finalizing and can no longer be aborted.",
        );
      } finally {
        operation.complete();
        clearAgentRunContext(runId);
      }
    },
  );

  it("clears captured inputs before cancellation without discarding later arrivals", async () => {
    const state = await setupStop();
    const queued = (prompt: string) => {
      const input = createQueueTestRun({ prompt });
      input.run.config = state.cfg;
      input.run.agentId = "main";
      input.run.sessionKey = sessionKey;
      input.run.sessionId = state.entry.sessionId;
      return input;
    };
    const operation = createReplyOperation({
      sessionKey,
      sessionId: state.entry.sessionId,
      target: state.target,
      resetTriggered: false,
    });
    enqueueFollowupRun(
      sessionKey,
      queued("captured"),
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    const cancelled = createDeferred();
    let depthAtCancellation: number | undefined;
    operation.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => {
        depthAtCancellation = getFollowupQueueDepth(sessionKey);
        enqueueFollowupRun(
          sessionKey,
          queued("arrived after capture"),
          { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
          "none",
        );
        cancelled.resolve();
      },
    });
    let done = false;
    const stopping = (
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true)
    ).finally(() => {
      done = true;
    });
    onTestFinished(async () => {
      operation.complete();
      await stopping;
    });
    await cancelled.promise;
    expect(depthAtCancellation).toBe(0);
    expect(done).toBe(false);
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    operation.complete();
    await stopping;
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  });

  it("preserves a replacement run and its queued input after dispatch handoff", async () => {
    const state = await setupStop();
    const admitted = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      target: state.target,
      resetTriggered: false,
    });
    const dispatch = createDeferred();
    expect(state.isCommandTargetCurrent()).toBe(true);
    const pending = dispatch.promise.then(async () =>
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true),
    );
    admitted.complete();
    await replaceSessionEntry(
      { storePath: state.storePath, sessionKey },
      {
        sessionId: "session-b",
        updatedAt: Date.now(),
      },
    );
    const replacement = createReplyOperation({
      sessionKey,
      sessionId: "session-b",
      target: captureSessionTarget({ ...state.target, incarnation: "session-b" }),
      resetTriggered: false,
    });
    replacement.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    const queued = createQueueTestRun({ prompt: "next conversation" });
    queued.run.config = state.cfg;
    queued.run.agentId = "main";
    queued.run.sessionKey = sessionKey;
    queued.run.sessionId = "session-b";
    enqueueFollowupRun(
      sessionKey,
      queued,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    dispatch.resolve();
    const result = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(replacement.abortSignal.aborted).toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect(
      loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
    ).toBeUndefined();
    replacement.complete();
  });

  it.each([false, true])(
    "checks the published conversation at the Stop effect (rebound=%s)",
    async (rebound) => {
      const state = await setupStop();
      const address = {
        channel: "slack",
        accountId: "default",
        kind: "group" as const,
        peerId: "g12345678",
        threadId: "123.456",
      };
      const delivery = normalizeSessionDeliveryState({
        context: {
          channel: address.channel,
          accountId: address.accountId,
          to: "group:g12345678",
          threadId: address.threadId,
        },
      });
      const scope = { agentId: "main", storePath: state.storePath, sessionKey };
      await replaceSessionEntry(scope, { ...state.entry, chatType: "group", delivery });
      const childRunId = "selected-child";
      const childKey = `agent:main:subagent:${childRunId}`;
      const childSessionId = "selected-child-session";
      await replaceSessionEntry(
        { ...scope, sessionKey: childKey },
        { sessionId: childSessionId, updatedAt: Date.now() },
      );
      const childEntry = expectDefined(
        loadSessionEntry({ ...scope, sessionKey: childKey }),
        "selected child session",
      );
      publishSystemEventStoreConfig(state.cfg);
      const controllerStorePath = resolvePhysicalSessionStorePath(
        { sessionKey, agentId: "main" },
        state.cfg,
      );
      await addSubagentRunForTests({
        runId: childRunId,
        childSessionKey: childKey,
        childAgentId: "main",
        childSessionIdentity: {
          sessionId: childEntry.sessionId,
          lifecycleRevision: childEntry.lifecycleRevision,
        },
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: sessionKey,
        requesterStorePath: controllerStorePath,
        controllerSessionKey: sessionKey,
        controllerStorePath,
        task: "selected child requires current Stop authority",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const operation = createReplyOperation({
        agentId: "main",
        sessionKey,
        sessionId: state.entry.sessionId,
        target: state.target,
        resetTriggered: false,
      });
      const cancel = vi.fn(() => queueMicrotask(() => operation.complete()));
      operation.attachBackend({
        kind: "embedded",
        runId: "selected-parent",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");
      const child = createReplyOperation({
        agentId: "main",
        sessionKey: childKey,
        sessionId: childSessionId,
        target: captureSessionTarget({
          storeScope: state.storePath,
          sessionKey: childKey,
          incarnation: childSessionId,
          agentId: "main",
        }),
        resetTriggered: false,
      });
      const cancelChild = vi.fn(() => child.complete());
      child.attachBackend({
        kind: "embedded",
        runId: childRunId,
        cancel: cancelChild,
        isStreaming: () => true,
      });
      child.setPhase("running");
      const execIdentity = {
        agentId: "main",
        sessionKey,
        sessionId: state.entry.sessionId,
        runId: "selected-parent",
      };
      const releaseExec = createDeferred();
      let externalOwner: ExecRequestOwner | undefined;
      const execution = withExecRequestTurn({ identity: execIdentity }, async () => {
        externalOwner = expectDefined(captureExecRequestOwners(execIdentity)?.[0], "exec owner");
        await releaseExec.promise;
      });
      const prepared = await captureSessionEntryCurrentCheckAsync({
        ...scope,
        alternatives: [{ conversations: [{ ...address, sessionKey }] }],
        errorMessage: "The selected session changed before it could be stopped.",
      });
      const preparationReached = createDeferred();
      const releasePreparation = createDeferred();
      let earlyResult: boolean | undefined;
      const effectSqlCalls: number[] = [];
      const sessionSource = new Proxy(prepared.source, {
        apply(target, thisArg, args) {
          if (earlyResult === undefined) {
            return Reflect.apply(target, thisArg, args);
          }
          const sql = observeMainThreadSql();
          try {
            return Reflect.apply(target, thisArg, args);
          } finally {
            effectSqlCalls.push(sql.count());
            sql.restore();
          }
        },
      });
      const isCommandTargetCurrent = Object.assign(
        async () => {
          earlyResult = await prepared.isCurrent();
          if (pathKind === "fast") {
            // Fast Stop checks after child preparation; extend its existing async-check await.
            preparationReached.resolve();
            await releasePreparation.promise;
          }
          return earlyResult;
        },
        { sessionSource },
      );
      const prepareChildSession = subagentControlSession.prepareSubagentKillSession;
      const preparation =
        pathKind === "command"
          ? vi
              .spyOn(subagentControlSession, "prepareSubagentKillSession")
              .mockImplementationOnce(async (...args) => {
                const session = await prepareChildSession(...args);
                preparationReached.resolve();
                await releasePreparation.promise;
                return session;
              })
          : undefined;
      let stopping: Promise<{ result: unknown } | { error: unknown }> | undefined;
      try {
        stopping = (
          pathKind === "fast"
            ? tryFastAbortFromMessage({ ...state, isCommandTargetCurrent })
            : handleStopCommand({ ...state.params, opts: { isCommandTargetCurrent } }, true)
        ).then(
          (result) => ({ result }),
          (error: unknown) => {
            preparationReached.reject(error);
            return { error };
          },
        );
        await preparationReached.promise;
        expect(earlyResult).toBe(true);
        if (rebound) {
          // A real worker commit changes only the competing row, after the early check.
          await replaceSessionEntry(
            { ...scope, sessionKey: `${sessionKey}:thread:123.456` },
            {
              sessionId: "session-b",
              updatedAt: state.entry.updatedAt + 1000,
              chatType: "group",
              delivery,
            },
          );
        }
        effectSqlCalls.length = 0;
        releasePreparation.resolve();
        const outcome = await stopping;
        if (rebound) {
          // These effects are checked before the rejection so baseline fails on real harm.
          expect(cancel).not.toHaveBeenCalled();
          expect(operation.abortSignal.aborted).toBe(false);
          expect(cancelChild).not.toHaveBeenCalled();
          expect(child.abortSignal.aborted).toBe(false);
          expect(externalOwner?.signal.aborted).toBe(false);
          expect(loadSessionEntry(scope)?.abortedLastRun).not.toBe(true);
          expect(outcome).toEqual({
            error: expect.objectContaining({
              message: "The selected session changed before it could be stopped.",
            }),
          });
        } else {
          expect(outcome).toMatchObject({
            result:
              pathKind === "fast"
                ? { handled: true, aborted: true }
                : {
                    shouldContinue: false,
                    reply: { text: expect.stringContaining("Stopped 1 sub-agent.") },
                  },
          });
          expect(cancel).toHaveBeenCalledOnce();
          expect(operation.abortSignal.aborted).toBe(true);
          expect(cancelChild).toHaveBeenCalledOnce();
          expect(child.abortSignal.aborted).toBe(true);
          expect(externalOwner?.signal.aborted).toBe(true);
          expect(loadSessionEntry(scope)?.abortedLastRun).toBe(true);
        }
        expect(effectSqlCalls.length).toBeGreaterThan(0);
        expect(effectSqlCalls.every((calls) => calls === 0)).toBe(true);
      } finally {
        releasePreparation.resolve();
        await stopping;
        preparation?.mockRestore();
        operation.complete();
        child.complete();
        releaseExec.resolve();
        await Promise.all([operation.ownerSettlement, child.ownerSettlement, execution]);
        prepared.release();
        await releaseSubagentRun(childRunId);
        publishSystemEventStoreConfig(getRuntimeConfig());
      }
    },
  );
}
