import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.types.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import * as gatewayActiveWork from "../infra/gateway-active-work.js";
import { createSafeGatewayRestartPreflight } from "../infra/restart-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { getSessionControllerOperation } from "../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  getSessionControllerWorkCount,
} from "../sessions/session-controller.lifecycle.js";
import { getRpcSource, isRpcSourceExecuting } from "../sessions/session-controller.rpc-sources.js";
import * as chatRestartRecovery from "./server-methods/chat-restart-recovery.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import { collectHistoryTextValues } from "./session-history-fixtures.test-support.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  dispatchInboundMessageMock,
  mockGetReplyFromConfigOnce,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

let ws: WebSocket;

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
});
const {
  expectRecordFields,
  request,
  readHistory,
  sendChat,
  sendChatAndExpectStarted,
  settleGatewayFixture,
  waitForAgentRunDrained,
  waitForEvent,
  withMainSessionStore,
} = gatewaySuite;

async function withSessionEntries(
  entries: Parameters<typeof writeSessionStore>[0]["entries"],
  run: () => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-"));
  testState.sessionStorePath = path.join(dir, "sessions.json");
  try {
    await writeSessionStore({ entries });
    await run();
  } finally {
    // Detached work must finish before retiring its store, including after failed assertions.
    await settleGatewayFixture();
    testState.sessionStorePath = undefined;
    await removeTempDir(dir);
  }
}

describe("gateway server chat", () => {
  const waitForChatEvent = (runId: string, state = "final") =>
    waitForEvent("chat", { runId, state });

  test("chat.send rejects archived sessions before dispatch", async () => {
    await withMainSessionStore(
      async () => {
        dispatchInboundMessageMock.mockClear();
        expect(
          await sendChat("proof-chat-archived-session", "blocked while archived"),
        ).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: 'Session "agent:main:main" is archived. Restore it before starting new work.',
          },
        });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      },
      { archivedAt: Date.now() },
    );
  });

  test("chat.send fences the admitted session settings", async () => {
    await withMainSessionStore(async () => {
      await request("sessions.patch", {
        key: "main",
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      const accepted = await sendChat(
        "idem-chat-settings-cas-success",
        "use the matched settings",
        {
          expectedPermissionMode: "guarded",
          expectedToolOverrides: { webSearch: false },
        },
      );
      expect(accepted.ok).toBe(true);
      await waitForAgentRunDrained("idem-chat-settings-cas-success");

      await request("sessions.patch", {
        key: "main",
        permissionMode: "read-only",
        toolOverrides: { skills: { release: false } },
      });
      const rejected = await sendChat(
        "idem-chat-settings-cas-conflict",
        "do not use stale settings",
        {
          expectedPermissionMode: "guarded",
          expectedToolOverrides: { webSearch: false },
        },
      );
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          details: { reason: "session-settings-changed" },
        },
      });
    });
  });

  test("chat.send keeps stored settings for legacy callers after the session row broadens", async () => {
    await withMainSessionStore(async () => {
      const dispatchEntered = createDeferred<InternalGetReplyOptions | undefined>();
      const releaseDispatch = createDeferred();
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const params = args as { replyOptions?: InternalGetReplyOptions };
        dispatchEntered.resolve(params.replyOptions);
        await releaseDispatch.promise;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      await request("sessions.patch", {
        key: "main",
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      const accepted = await sendChat("idem-chat-settings-final-freeze", "keep admitted authority");
      expect(accepted.ok).toBe(true);
      const admittedOptions = await dispatchEntered.promise;

      await request("sessions.patch", { key: "main", permissionMode: "full", toolOverrides: null });
      expect(admittedOptions?.admittedSessionSettings).toEqual({
        permissionMode: "guarded",
        toolOverrides: { webSearch: false },
      });
      releaseDispatch.resolve();
      await waitForAgentRunDrained("idem-chat-settings-final-freeze");
    });
  });

  test("keeps started chat dispatch on its retained request root", async () => {
    await withMainSessionStore(async () => {
      let subordinateAdmissionClosed: boolean | undefined;
      dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        const suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension).not.toBeNull();
        try {
          subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
        } finally {
          suspension?.rollback();
        }
        const [params] = args as [{ dispatcher: ReplyDispatcher }];
        params.dispatcher.sendFinalReply({ text: "detached root stayed live" });
        params.dispatcher.markComplete();
        await params.dispatcher.waitForIdle();
        return {
          queuedFinal: true,
          counts: params.dispatcher.getQueuedCounts(),
        };
      });
      const finalPromise = waitForChatEvent("idem-chat-detached-root");

      await sendChatAndExpectStarted("idem-chat-detached-root", "prove detached root transfer");
      await waitForFast(() => {
        expect(subordinateAdmissionClosed).toBe(false);
      });
      await finalPromise;
      await gatewaySuite.requestExecution.waitForCompletion("idem-chat-detached-root");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
  });

  test("sessions.list projects an accepted chat.send before backend execution starts", async () => {
    await withMainSessionStore(async () => {
      const dispatchEntered = createDeferred();
      const releaseDispatch = createDeferred();
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        dispatchEntered.resolve();
        await releaseDispatch.promise;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      const runId = "idem-chat-accepted-session-projection";
      try {
        const accepted = await sendChat(runId, "hold before backend execution");
        expect(accepted).toMatchObject({ ok: true, payload: { runId, status: "started" } });
        await dispatchEntered.promise;
        expect(isRpcSourceExecuting(getRpcSource(runId))).toBe(false);

        const listed = await rpcReq<{ sessions?: unknown[] }>(ws, "sessions.list", {});
        expect(listed.ok).toBe(true);
        expect(listed.payload?.sessions).toContainEqual(
          expect.objectContaining({
            key: "agent:main:main",
            hasActiveRun: true,
            activeRunIds: [runId],
            status: "queued",
          }),
        );
      } finally {
        releaseDispatch.resolve();
        await waitForAgentRunDrained(runId);
      }
    });
  });

  test("chat.abort does not persist a partial after finalizing dispatch refuses cancellation", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-finalizing-abort-refusal";
      const dispatchFinalizing = createDeferred();
      const releaseDispatch = createDeferred();
      try {
        const partialPublished = waitForChatEvent(runId, "delta");
        mockGetReplyFromConfigOnce(async (_ctx, replyOptions) => {
          const replyOperation = expectDefined(
            replyOptions?.replyOperation,
            "expected admitted reply operation",
          );
          expect(replyOptions?.abortSignal).toBe(replyOperation.abortSignal);
          replyOptions?.onAgentRunStart?.(runId);
          emitAgentEvent({
            runId,
            stream: "assistant",
            data: { text: "stale aborted partial" },
          });
          replyOperation.freezeAbort();
          dispatchFinalizing.resolve();
          await releaseDispatch.promise;
          return undefined;
        });

        await sendChatAndExpectStarted(runId, "finish successfully");
        expect((await partialPublished).payload?.message).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "stale aborted partial" }],
        });
        await dispatchFinalizing.promise;
        await request(
          "chat.abort",
          { sessionKey: "main", runId },
          { ok: true, aborted: false, runIds: [] },
        );

        releaseDispatch.resolve();
        await waitForAgentRunDrained(runId);
        mockGetReplyFromConfigOnce(async () => undefined);
        await sendChatAndExpectStarted(`${runId}-successor`, "continue after finalization");
        await waitForAgentRunDrained(`${runId}-successor`);
        await settleGatewayFixture();

        expect(collectHistoryTextValues((await readHistory())?.messages ?? [])).not.toContain(
          "stale aborted partial",
        );
      } finally {
        releaseDispatch.resolve();
      }
    });
  });

  test.each([
    { method: "send", message: "hello from dashboard" },
    { method: "steer", message: "follow-up from dashboard" },
  ])(
    "sessions.$method returns the committed history position when starting an existing session input",
    async ({ method, message }) => {
      const sessionKey = `agent:main:dashboard:test-${method}`;
      const runId = `idem-sessions-${method}-1`;
      await withSessionEntries(
        {
          [sessionKey]: { sessionId: `sess-dashboard-${method}`, updatedAt: Date.now() },
        },
        async () => {
          const res = await request(
            `sessions.${method}`,
            {
              key: sessionKey,
              message,
              idempotencyKey: runId,
            },
            { runId, status: "started", messageSeq: 1 },
          );
          await waitForAgentRunDrained(runId);

          const users = ((await readHistory(sessionKey))?.messages ?? []).filter(
            (entry) => expectRecordFields(entry, {}).role === "user",
          );
          expect(users).toHaveLength(1);
          expect(users[0]).toMatchObject({
            role: "user",
            __openclaw: { seq: res.payload?.messageSeq, idempotencyKey: `${runId}:user` },
          });
          expect(collectHistoryTextValues(users)).toEqual([message]);
        },
      );
    },
  );

  const startInterruptibleChatRun = async (runId: string, settlementGate?: Promise<void>) => {
    const activeRunStarted = createDeferred();
    const producer = { cancelled: false, settled: false };
    mockGetReplyFromConfigOnce(async (_ctx, opts) => {
      activeRunStarted.resolve(undefined);
      if (!opts?.abortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          opts?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      producer.cancelled = true;
      // The gate holds the real producer after cancellation, through replacement acknowledgement.
      if (settlementGate) {
        await settlementGate;
      }
      producer.settled = true;
      return undefined;
    });
    const active = await sendChat(runId, "captured active turn");
    expect(active.ok).toBe(true);
    await activeRunStarted.promise;
    return producer;
  };

  test.each(["chat.send", "sessions.send"] as const)(
    "%s acknowledges an interrupt before predecessor settlement",
    async (method) => {
      await withMainSessionStore(async () => {
        await updateSessionEntry(
          {
            sessionKey: "main",
            storePath: expectDefined(testState.sessionStorePath, "session store path"),
          },
          () => ({ queueMode: "interrupt" }),
        );
        const oldRunId = `idem-${method}-interrupt-old`;
        const newRunId = `idem-${method}-interrupt-active`;
        const releasePredecessor = createDeferred();
        const predecessor = await startInterruptibleChatRun(oldRunId, releasePredecessor.promise);
        try {
          await expect(
            rpcReq(ws, method, {
              ...(method === "chat.send"
                ? { sessionKey: "main", queueMode: "interrupt" }
                : { key: "main" }),
              message: "replace the captured turn",
              idempotencyKey: newRunId,
            }),
          ).resolves.toMatchObject({
            ok: true,
            payload: { runId: newRunId, status: "started", interruptedActiveRun: true },
          });
          expect(predecessor.cancelled).toBe(true);
          expect(predecessor.settled).toBe(false);
        } finally {
          releasePredecessor.resolve();
        }
        await gatewaySuite.requestExecution.waitForCompletion(oldRunId);
        await waitForAgentRunDrained(newRunId);
      });
    },
  );

  test("chat.send interrupt keeps committed cancellation when the backend observer throws", async () => {
    await withMainSessionStore(async () => {
      await startInterruptibleChatRun("idem-chat-interrupt-throw-old");

      const operation = getSessionControllerOperation(
        "agent:main:main",
        captureSessionTarget({
          storeScope: expectDefined(testState.sessionStorePath, "session store path"),
          sessionKey: "agent:main:main",
          incarnation: "sess-main",
        }),
      );
      expect(operation).toBeDefined();
      operation?.attachBackend({
        kind: "embedded",
        cancel: () => {
          throw new Error("cancel failed");
        },
        isStreaming: () => true,
      });

      const res = await sendChat("idem-chat-interrupt-throw-new", "replace the captured turn", {
        queueMode: "interrupt",
      });
      expect(res).toMatchObject({
        ok: true,
        payload: {
          runId: "idem-chat-interrupt-throw-new",
          status: "started",
          interruptedActiveRun: true,
        },
      });
      await waitForFast(() => expect(getSessionControllerWorkCount()).toBe(0));
      await gatewaySuite.requestExecution.waitForCompletion("idem-chat-interrupt-throw-old");
      await gatewaySuite.requestExecution.waitForCompletion("idem-chat-interrupt-throw-new");
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      await request("sessions.reset", { key: "main", reason: "new" });
    });
  });

  test("chat.send interrupt leaves a subordinate session effect with its owner", async () => {
    await withMainSessionStore(async () => {
      const storePath = expectDefined(testState.sessionStorePath, "session store path");
      const onInterrupt = vi.fn();
      const interrupted = createDeferred();
      const activeAdmission = await beginSessionEffect({
        scope: storePath,
        identities: ["agent:main:main", "sess-main"],
        assertAllowed: () => {},
        onInterrupt: () => {
          onInterrupt();
          interrupted.resolve(undefined);
        },
      });
      const activeWork = activeAdmission.run(async () => {
        await interrupted.promise;
        activeAdmission.release();
      });

      try {
        const res = await sendChat(
          "idem-chat-interrupt-non-reply",
          "replace non-reply session work",
          {
            queueMode: "interrupt",
          },
        );

        expect(onInterrupt).not.toHaveBeenCalled();
        expect(res).toMatchObject({
          ok: true,
          payload: { runId: "idem-chat-interrupt-non-reply", status: "started" },
        });
        expect(res.payload).not.toHaveProperty("interruptedActiveRun");
        await waitForAgentRunDrained("idem-chat-interrupt-non-reply");
      } finally {
        interrupted.resolve(undefined);
        activeAdmission.release();
        await activeWork;
      }
      await waitForFast(() => expect(getSessionControllerWorkCount()).toBe(0));
    });
  });

  test("sessions.send creates a configured agent main session before sending", async () => {
    testState.agentsConfig = {
      entries: { main: {}, orion: {} },
    };
    try {
      await withSessionEntries({}, async () => {
        await prepareGatewayReplyRuntimeForTest({ force: true });

        await request(
          "sessions.send",
          {
            key: "agent:orion:main",
            message: "hello orion",
            idempotencyKey: "idem-sessions-send-orion",
          },
          { runId: "idem-sessions-send-orion" },
        );

        expect(
          loadSessionEntry({
            sessionKey: "agent:orion:main",
            storePath: testState.sessionStorePath,
          })?.sessionId,
        ).toBeTypeOf("string");
        await waitForAgentRunDrained("idem-sessions-send-orion");
      });
    } finally {
      testState.agentsConfig = undefined;
    }
  });

  test.each([true, false])(
    "sessions.abort resolves an active dashboard run with session key=%s",
    async (includeKey) => {
      const key = "agent:main:dashboard:test-abort";
      const runId = `idem-sessions-abort-${includeKey ? "key" : "runid"}`;
      await withSessionEntries(
        { [key]: { sessionId: "sess-dashboard-abort", updatedAt: Date.now() } },
        async () => {
          await request("sessions.send", {
            key,
            message: "hello",
            idempotencyKey: runId,
            timeoutMs: 30_000,
          });
          const cancelledEventP = waitForEvent("agent", {
            runId,
            stream: "lifecycle",
            data: expect.objectContaining({ phase: "end", stopReason: "rpc" }),
          });
          void cancelledEventP.catch(() => undefined);

          const abortRes = await request("sessions.abort", {
            ...(includeKey ? { key } : {}),
            runId,
          });
          expect(["aborted", "no-active-run"]).toContain(abortRes.payload?.status);
          if (abortRes.payload?.status === "aborted") {
            expect(abortRes.payload?.abortedRunId).toBe(runId);
            const cancelledEvent = await cancelledEventP;
            expectRecordFields(cancelledEvent.payload?.data, {
              phase: "end",
              status: "cancelled",
              aborted: true,
              stopReason: "rpc",
            });
            await request(
              "agent.wait",
              { runId, timeoutMs: 0 },
              {
                runId,
                status: "error",
                stopReason: "rpc",
              },
            );
          } else {
            expect(abortRes.payload?.abortedRunId).toBeNull();
          }
          await gatewaySuite.requestExecution.waitForCompletion(runId);
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        },
      );
    },
  );

  test("persists a failed chat dispatch before restart drain can finish", async ({ signal }) => {
    await withMainSessionStore(async (dir) => {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            sessionFile: path.join(dir, "sess-main.jsonl"),
            updatedAt: 1_000,
            startedAt: 900,
          },
        },
      });
      await request("sessions.subscribe", {});
      const rejectDispatch = createDeferred();
      const releasePersistence = createDeferred();
      const dispatchStarted = createDeferred();
      const persistenceEntered = createDeferred();
      const terminalizeAdmission = chatRestartRecovery.terminalizeRestartSafeChatAdmission;
      const persistSpy = vi
        .spyOn(chatRestartRecovery, "terminalizeRestartSafeChatAdmission")
        .mockImplementation(async (params) => {
          if (params.clientRunId === "idem-dispatch-error-1") {
            persistenceEntered.resolve();
            await releasePersistence.promise;
          }
          return terminalizeAdmission(params);
        });
      const createSnapshot = gatewayActiveWork.createGatewayActiveWorkSnapshot;
      const snapshotSpy = vi.spyOn(gatewayActiveWork, "createGatewayActiveWorkSnapshot");
      const messagePromises: Promise<unknown>[] = [];
      const sessionChanged = await (async () => {
        try {
          dispatchInboundMessageMock.mockImplementationOnce(async () => {
            dispatchStarted.resolve();
            await rejectDispatch.promise;
            throw new Error("provider rejected request");
          });
          const errorPromise = waitForChatEvent("idem-dispatch-error-1", "error");
          messagePromises.push(errorPromise);
          const sessionChangedPromise = waitForEvent("sessions.changed", {
            sessionKey: "agent:main:main",
            status: "failed",
            lastRunId: "idem-dispatch-error-1",
            hasActiveRun: false,
          });
          messagePromises.push(sessionChangedPromise);
          const res = await sendChat("idem-dispatch-error-1", "run: pwd");
          expect(res.ok).toBe(true);
          await withinTest(dispatchStarted.promise, signal);
          rejectDispatch.resolve();
          await withinTest(persistenceEntered.promise, signal);
          // Begin draining with the failure write already held. Restart cancels
          // unclaimed inputs, which this dispatcher mock deliberately does not claim.
          markGatewayRestartDraining();
          const restartInspectors = {
            getQueueSize: () => 0,
            getPendingReplies: () => 0,
            getEmbeddedRuns: () => 0,
            getCronRuns: () => 0,
            getBackgroundExecSessions: () => 0,
            getAgentRuns: () => 0,
            getAcpRuns: () => 0,
            getMediaRuns: () => 0,
          };
          snapshotSpy.mockImplementationOnce((inspectors, options) =>
            createSnapshot({ ...inspectors, ...restartInspectors }, options),
          );
          expect(createSafeGatewayRestartPreflight()).toMatchObject({
            safe: false,
            counts: { rootRequests: 1 },
          });
          releasePersistence.resolve();
          await errorPromise;
          const changed = await sessionChangedPromise;
          await withinTest(
            gatewaySuite.requestExecution.waitForCompletion("idem-dispatch-error-1"),
            signal,
          );
          snapshotSpy.mockImplementationOnce((inspectors, options) =>
            createSnapshot({ ...inspectors, ...restartInspectors }, options),
          );
          expect(createSafeGatewayRestartPreflight().safe).toBe(true);
          return changed;
        } finally {
          rejectDispatch.resolve();
          releasePersistence.resolve();
          await Promise.allSettled(messagePromises);
          persistSpy.mockRestore();
          snapshotSpy.mockRestore();
          resetGatewayWorkAdmission();
        }
      })();
      expectRecordFields(sessionChanged.payload, {
        sessionId: "sess-main",
        status: "failed",
        lastRunId: "idem-dispatch-error-1",
        hasActiveRun: false,
      });

      const sessionsRes = await rpcReq<{ sessions?: unknown[] }>(ws, "sessions.list", {});
      expect(sessionsRes.ok).toBe(true);
      const session = sessionsRes.payload?.sessions?.find(
        (row) => isRecord(row) && row.key === "agent:main:main",
      );
      expectRecordFields(session, {
        status: "failed",
        lastRunId: "idem-dispatch-error-1",
        hasActiveRun: false,
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
        runtimeMs: expect.any(Number),
      });
    });
  });
});
