import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import {
  afterAll,
  assert,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import type { WebSocket, RawData } from "ws";
import { mergeChatStreamMessage } from "../../packages/gateway-client/src/chat-stream-message.js";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  reduceSessionProjectionRunEvent,
} from "../../packages/gateway-client/src/session-projection.js";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSessionsYieldTool } from "../agents/tools/sessions-yield-tool.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.types.js";
import { buildWaitingStatusPayload } from "../auto-reply/reply/waiting-status.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import * as replyMedia from "./server-methods/chat-reply-media.js";
import * as transcriptPersistence from "./server-methods/chat-transcript-persistence.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { createMainChatSessionStoreFixture } from "./server.chat-session-store.test-support.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  gatewayReplyMock,
  mockGetReplyFromConfigOnce,
  prepareGatewayReplyRuntimeForTest,
  onceMessage,
  rpcReq,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const CHAT_RESPONSE_TIMEOUT_MS = 10_000;
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

describe("queued WebChat follow-up delivery", () => {
  let requestExecution: Awaited<ReturnType<typeof observeGatewayRunExecution>>;
  let lifecycleWrites: Promise<void>[];
  let observedFollowupRunId: string | undefined;
  beforeEach(async () => {
    dispatchInboundMessageMock.mockReset();
    gatewayReplyMock.mockReset().mockResolvedValue(undefined);
    requestExecution = await observeGatewayRunExecution();
    lifecycleWrites = [];
    observedFollowupRunId = undefined;
    const persistLifecycle = lifecycleState.persistGatewaySessionLifecycleEvent;
    const persistenceSpy = vi
      .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
      .mockImplementation((params) => {
        const write = persistLifecycle(params);
        if (params.event.runId === observedFollowupRunId) {
          lifecycleWrites.push(write);
        }
        return write;
      });
    onTestFinished(() => {
      persistenceSpy.mockRestore();
    });
  });
  afterEach(async () => {
    try {
      await settleGatewayFixture();
    } finally {
      await requestExecution.restore();
    }
  });
  const settleGatewayFixture = async () => {
    await requestExecution.waitForCompletion();
    // Synthetic events lack a request scope; join the producer before draining its writers.
    await Promise.all(lifecycleWrites);
    await drainOpenClawAgentWriteQueuesForTest();
    await flushPendingSessionsChangedEvents();
    expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(0);
  };
  const mainSessionStore = createMainChatSessionStoreFixture(settleGatewayFixture);
  beforeAll(mainSessionStore.prepare);
  afterAll(mainSessionStore.dispose);
  const withMainSessionStore = mainSessionStore.run;

  test.each([
    {
      name: "text",
      completion: { kind: "completed" as const },
      payloads: [{ text: "late answer arrived over the live WebSocket" }],
      state: "final",
    },
    {
      name: "canvas",
      completion: { kind: "completed" as const, allowCanvasOnly: true as const },
      payloads: [],
      state: "final",
    },
    {
      name: "silent-canvas",
      completion: { kind: "completed" as const, allowCanvasOnly: true as const },
      payloads: [],
      state: "final",
    },
    {
      name: "suppressed-canvas",
      completion: { kind: "completed" as const },
      payloads: [],
      state: "final",
    },
    {
      name: "timeout",
      completion: {
        kind: "failed" as const,
        error: "provider timed out",
        errorKind: "timeout" as const,
        stopReason: "timeout",
      },
      payloads: [],
      state: "error",
    },
    {
      name: "abort",
      completion: { kind: "aborted" as const, stopReason: "restart" },
      payloads: [],
      state: "aborted",
    },
  ])(
    "completes a queued WebChat $name once after its source ends",
    async ({ name, completion, payloads, state }) => {
      await withMainSessionStore(async () => {
        let options: InternalGetReplyOptions | undefined;
        const releaseDispatch = createDeferred();
        dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
          options = (args as { replyOptions?: InternalGetReplyOptions }).replyOptions;
          options?.turnAdoptionLifecycle?.onDeferred?.();
          await releaseDispatch.promise;
          return {};
        });

        const sourceRunId = `idem-live-webchat-late-source-${name}`;
        const sourceFinal = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "chat" &&
            event.payload?.state === "final" &&
            event.payload?.runId === sourceRunId,
          CHAT_RESPONSE_TIMEOUT_MS,
        );
        const response = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "queue a reply while the previous run is active",
          idempotencyKey: sourceRunId,
        });
        expect(response.ok).toBe(true);
        await waitForFast(() => expect(options?.onQueuedFollowupReplyBatch).toBeTypeOf("function"));
        releaseDispatch.resolve();
        await sourceFinal;

        const followupRunId = `idem-live-webchat-late-followup-${name}`;
        observedFollowupRunId = followupRunId;
        const terminalFrames: unknown[] = [];
        const deltaFrames: Extract<ChatEvent, { state: "delta" }>[] = [];
        const recordFollowup = (raw: RawData) => {
          const frame = JSON.parse(rawDataToString(raw));
          if (
            frame.event === "chat" &&
            frame.payload?.runId === followupRunId &&
            frame.payload?.state !== "delta"
          ) {
            terminalFrames.push(frame.payload);
          } else if (frame.event === "chat" && frame.payload?.runId === followupRunId) {
            deltaFrames.push(frame.payload);
          }
        };
        ws.on("message", recordFollowup);
        const queuedFinal = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "chat" &&
            event.payload?.state === state &&
            event.payload?.runId === followupRunId,
          CHAT_RESPONSE_TIMEOUT_MS,
        );
        registerAgentRunContext(followupRunId, { sessionKey: "main" });
        registerAgentRunContext(followupRunId, { completionSource: "reply-dispatch" });
        if (
          name === "canvas" ||
          name === "silent-canvas" ||
          name === "suppressed-canvas" ||
          name === "abort"
        ) {
          emitAgentEvent({
            runId: followupRunId,
            stream: "tool",
            data: {
              phase: "result",
              name: "show_widget",
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      kind: "canvas",
                      presentation: {
                        target: "assistant_message",
                        title: "Result",
                        sandbox: "scripts",
                      },
                      view: {
                        id: "result",
                        url: "/__openclaw__/canvas/documents/result/index.html",
                      },
                    }),
                  },
                ],
              },
            },
          });
        }
        if (name === "text") {
          await options?.onQueuedFollowupReplyBatch?.({
            kind: "queued-followup",
            completion: { kind: "progress" },
            runId: followupRunId,
            originatingChannel: "webchat",
            payloads: [{ text: "working" }],
          });
        }
        emitAgentEvent({
          runId: followupRunId,
          stream: "assistant",
          data: {
            text:
              name === "canvas" || name === "suppressed-canvas"
                ? ""
                : name === "silent-canvas"
                  ? "NO_REPLY"
                  : "late answer arrived over the live WebSocket",
          },
        });
        if (completion.kind === "failed" || completion.kind === "aborted") {
          emitAgentEvent({
            runId: followupRunId,
            stream: "assistant",
            data: {
              text: "late answer arrived over the live WebSocket tail",
              delta: " tail",
            },
          });
        }
        emitAgentEvent({
          runId: followupRunId,
          stream: "lifecycle",
          data: {
            phase: completion.kind === "failed" ? "error" : "end",
            executionSettled: true,
            ...(completion.kind === "aborted" ? { aborted: true, stopReason: "restart" } : {}),
          },
        });
        await options?.onQueuedFollowupReplyBatch?.({
          kind: "queued-followup",
          completion,
          runId: followupRunId,
          originatingChannel: "webchat",
          payloads,
        });
        let completed: Awaited<typeof queuedFinal>;
        try {
          completed = await queuedFinal;
          await rpcReq(ws, "health", {});
        } finally {
          ws.off("message", recordFollowup);
          options?.turnAdoptionLifecycle?.onSettled?.();
        }
        expect(completed.payload?.state).toBe(state);
        if (name === "timeout") {
          expect(completed.payload).toMatchObject({ errorKind: "timeout", stopReason: "timeout" });
        }
        if (name === "abort") {
          expect(completed.payload).toMatchObject({ stopReason: "restart" });
        }
        if (name === "canvas" || name === "abort") {
          expect(completed.payload?.message).toMatchObject({
            content: expect.arrayContaining([expect.objectContaining({ type: "canvas" })]),
          });
        }
        if (name === "silent-canvas" || name === "suppressed-canvas") {
          expect(completed.payload?.message).toBeUndefined();
        }
        if (name === "text") {
          expect(completed.payload?.message).toMatchObject({
            content: [
              { type: "text", text: "working" },
              { type: "text", text: "late answer arrived over the live WebSocket" },
            ],
          });
        }
        expect(terminalFrames).toHaveLength(1);
        if (completion.kind === "failed" || completion.kind === "aborted") {
          const liveMessage = deltaFrames.reduce<unknown>(
            (previous, event) => mergeChatStreamMessage(previous, event),
            undefined,
          );
          expect(liveMessage).toMatchObject({
            content: expect.arrayContaining([
              { type: "text", text: "late answer arrived over the live WebSocket tail" },
            ]),
          });
        }
        if (completion.kind === "aborted") {
          expect(completed.payload?.message).toMatchObject({
            content: expect.arrayContaining([
              { type: "text", text: "late answer arrived over the live WebSocket tail" },
            ]),
          });
        }
      });
    },
  );

  test.each([
    { lane: "direct", acknowledgment: "Research started; results will follow.", media: false },
    { lane: "direct", acknowledgment: undefined, media: false },
    { lane: "queued", acknowledgment: "Research started; results will follow.", media: false },
    { lane: "queued", acknowledgment: undefined, media: false },
    { lane: "direct", acknowledgment: "Work started; here is the preview.", media: true },
    { lane: "queued", acknowledgment: "Work started; here is the preview.", media: true },
  ])(
    "persists one public waiting reply for $lane (ack=$acknowledgment, media=$media)",
    async ({ lane, acknowledgment, media }) => {
      await withMainSessionStore(async () => {
        const caseId = `${lane}-${acknowledgment ? "explicit" : "default"}-${media}`;
        const sourceRunId = `waiting-source-${caseId}`;
        const followupRunId = `waiting-followup-${caseId}`;
        const runId = lane === "direct" ? sourceRunId : followupRunId;
        observedFollowupRunId = runId;
        const expectedText =
          acknowledgment ?? "I’m continuing this work and will send the result when it is ready.";
        const content = [
          { type: "text", text: expectedText },
          ...(media ? [expect.objectContaining({ type: "image", mimeType: "image/png" })] : []),
        ];
        const frames: Record<string, unknown>[] = [];
        const record = (raw: RawData) => {
          const frame = JSON.parse(rawDataToString(raw));
          if (frame.event === "chat" && frame.payload?.runId === runId) {
            frames.push(frame.payload);
          }
        };
        ws.on("message", record);
        let options: InternalGetReplyOptions | undefined;
        const dispatched = createDeferred();
        let publicAcknowledgment: string | undefined;
        const tool = createSessionsYieldTool({
          sessionId: "sess-main",
          claimYield: () => true,
          onYield: (_privateContext, publicText) => {
            publicAcknowledgment = publicText;
          },
        });
        const result = await tool.execute("yield-call", {
          message: "Private resume context must not be published.",
          acknowledgment,
        });
        expect(result).not.toHaveProperty("details.message");
        const payload = buildWaitingStatusPayload({
          completion: { expectation: "required", outcome: "pending" },
          yielded: acknowledgment !== undefined,
          continuationPending: acknowledgment === undefined,
          yieldAcknowledgment: publicAcknowledgment,
          hasVisibleMessageDelivery: false,
        });
        assert(payload);
        if (media) {
          payload.mediaUrl =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
        }
        dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
          const params = args as {
            replyOptions: InternalGetReplyOptions;
            dispatcher: ReplyDispatcher;
          };
          options = params.replyOptions;
          if (lane === "queued") {
            options.turnAdoptionLifecycle?.onDeferred?.();
          } else {
            options.onAgentRunStart?.(sourceRunId);
            params.dispatcher.sendFinalReply(payload);
            params.dispatcher.markComplete();
            await params.dispatcher.waitForIdle();
            emitAgentEvent({
              runId: sourceRunId,
              stream: "lifecycle",
              data: { phase: "end", yielded: true },
            });
          }
          dispatched.resolve();
          return {};
        });
        try {
          const response = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "Research this and report when ready.",
            idempotencyKey: sourceRunId,
          });
          expect(response.ok).toBe(true);
          await dispatched.promise;
          await requestExecution.waitForCompletion();
          if (lane === "queued") {
            registerAgentRunContext(followupRunId, {
              sessionKey: "main",
              completionSource: "reply-dispatch",
            });
            const batch = {
              kind: "queued-followup" as const,
              runId: followupRunId,
              originatingChannel: "webchat",
              payloads: [payload],
              completion: { kind: "completed" as const },
            };
            await options?.onQueuedFollowupReplyBatch?.(batch);
            // A replay of the same queued terminal must not publish another assistant row.
            await options?.onQueuedFollowupReplyBatch?.(batch);
            options?.turnAdoptionLifecycle?.onSettled?.();
          } else {
            expect(
              (
                await rpcReq(ws, "chat.send", {
                  sessionKey: "main",
                  message: "Research this and report when ready.",
                  idempotencyKey: sourceRunId,
                })
              ).ok,
            ).toBe(true);
          }
          // Reading over the same socket orders all earlier publication frames before the assertion.
          const history = await rpcReq<{ messages: Array<{ role: string; content: unknown[] }> }>(
            ws,
            "chat.history",
            { sessionKey: "main" },
          );
          expect(history.ok).toBe(true);
          const assistant = history.payload?.messages.filter(
            (message) => message.role === "assistant",
          );
          expect(assistant).toEqual([expect.objectContaining({ content })]);
          const visible = frames.filter((frame) => frame.state === "final" && frame.message);
          expect(visible).toEqual([
            expect.objectContaining({
              message: expect.objectContaining({ content }),
            }),
          ]);
          expect(JSON.stringify([frames, history.payload])).not.toContain("Private resume context");
          const reloaded = await rpcReq<{ messages: Array<{ role: string; content: unknown[] }> }>(
            ws,
            "chat.history",
            {
              sessionKey: "main",
            },
          );
          expect(reloaded.ok).toBe(true);
          expect(
            reloaded.payload?.messages.filter((message) => message.role === "assistant"),
          ).toEqual([expect.objectContaining({ content })]);
        } finally {
          ws.off("message", record);
          options?.turnAdoptionLifecycle?.onSettled?.();
        }
      });
    },
  );

  test.each(["direct fallback", "queued compaction"] as const)(
    "projects one waiting reply beside %s in either event order",
    async (lane) => {
      await withMainSessionStore(async () => {
        const sourceRunId = "mixed-source-" + lane;
        const runId = lane === "direct fallback" ? sourceRunId : "mixed-followup-" + lane;
        observedFollowupRunId = runId;
        const acknowledgment = "Research continues; the result will follow.";
        const payload = buildWaitingStatusPayload({
          completion: { expectation: "required", outcome: "pending" },
          yielded: true,
          yieldAcknowledgment: acknowledgment,
          hasVisibleMessageDelivery: false,
        });
        assert(payload);
        const notice =
          lane === "direct fallback"
            ? { text: "Model fallback notice", isFallbackNotice: true }
            : { text: "Context compacted", isCompactionNotice: true };
        const privateReasoning = {
          text: "Private resume context must not be published.",
          isReasoning: true,
        };
        const frames: Array<Record<string, unknown>> = [];
        const record = (raw: RawData) => {
          const frame = JSON.parse(rawDataToString(raw));
          if (frame.event === "chat" && frame.payload?.runId === runId) {
            frames.push(frame.payload);
          }
        };
        ws.on("message", record);
        let options: InternalGetReplyOptions | undefined;
        const dispatched = createDeferred();
        if (lane === "direct fallback") {
          await prepareGatewayReplyRuntimeForTest();
          mockGetReplyFromConfigOnce(async (_ctx, opts) => {
            opts?.onAgentRunStart?.(runId);
            emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", yielded: true } });
            dispatched.resolve();
            return [notice, privateReasoning, payload];
          });
        } else {
          dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
            options = (args as { replyOptions: InternalGetReplyOptions }).replyOptions;
            options.turnAdoptionLifecycle?.onDeferred?.();
            dispatched.resolve();
            return {};
          });
        }
        try {
          expect(
            (
              await rpcReq(ws, "chat.send", {
                sessionKey: "main",
                message: "Research this and report when ready.",
                idempotencyKey: sourceRunId,
              })
            ).ok,
          ).toBe(true);
          await dispatched.promise;
          await requestExecution.waitForCompletion();
          if (lane === "queued compaction") {
            registerAgentRunContext(runId, {
              sessionKey: "main",
              completionSource: "reply-dispatch",
            });
            await options?.onQueuedFollowupReplyBatch?.({
              kind: "queued-followup",
              runId,
              originatingChannel: "webchat",
              payloads: [notice, privateReasoning],
              completion: { kind: "progress" },
            });
            await options?.onQueuedFollowupReplyBatch?.({
              kind: "queued-followup",
              runId,
              originatingChannel: "webchat",
              payloads: [payload],
              completion: { kind: "completed" },
            });
            options?.turnAdoptionLifecycle?.onSettled?.();
          }
          const history = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", {
            sessionKey: "main",
          });
          expect(history.ok).toBe(true);
          const messages = history.payload?.messages ?? [];
          const acknowledgmentCount = (rows: readonly unknown[]) =>
            rows.filter((row) => JSON.stringify(row).includes(acknowledgment)).length;
          expect(acknowledgmentCount(messages)).toBe(1);
          for (const order of ["history-first", "live-first"]) {
            const scope = { sessionKey: "agent:main:main" };
            let projection = createSessionProjection(scope);
            const persist = () => {
              for (const message of messages) {
                projection = reduceSessionProjection(projection, {
                  type: "messagePersisted",
                  message,
                });
              }
            };
            if (order === "history-first") {
              persist();
            }
            for (const frame of frames) {
              projection =
                reduceSessionProjectionRunEvent(projection, frame, scope)?.projection ?? projection;
              if (frame.state === "final" && frame.message) {
                projection = projectLiveSessionMessage(projection, frame.message, { runId });
              }
            }
            if (order === "live-first") {
              persist();
            }
            expect.soft(acknowledgmentCount(projection.messages), order).toBe(1);
            projection = reconcileSessionProjectionSnapshot(projection, messages, scope);
            expect.soft(acknowledgmentCount(projection.messages), order + " reload").toBe(1);
            expect(JSON.stringify(projection.messages)).not.toContain("Private resume context");
          }
        } finally {
          ws.off("message", record);
          options?.turnAdoptionLifecycle?.onSettled?.();
        }
      });
    },
  );

  test.each([
    "committed",
    "rejected",
    "queued committed",
    "queued rejected",
    "source rejected",
  ] as const)("settles a waiting reply only after host publication (%s)", async (outcome) => {
    await withMainSessionStore(async () => {
      await prepareGatewayReplyRuntimeForTest();
      const runId = "deferred-waiting-" + outcome;
      const source = outcome === "source rejected";
      const queued = outcome.startsWith("queued");
      const rejected = outcome.endsWith("rejected");
      let options: InternalGetReplyOptions | undefined;
      observedFollowupRunId = runId;
      const acknowledgment = "Research started; the result will follow.";
      const payload = buildWaitingStatusPayload({
        completion: { expectation: "required", outcome: "pending" },
        continuationPending: true,
        yieldAcknowledgment: acknowledgment,
        hasVisibleMessageDelivery: false,
      });
      assert(payload);
      const appendEntered = createDeferred();
      const releaseAppend = createDeferred();
      const mediaSpy = source
        ? vi.spyOn(replyMedia, "withPreparedWebchatReplyMedia").mockImplementationOnce(async () => {
            appendEntered.resolve();
            await releaseAppend.promise;
            throw new Error("Synthetic waiting reply storage failure");
          })
        : undefined;
      const append = transcriptPersistence.appendAssistantTranscriptMessage;
      const appendSpy = vi
        .spyOn(transcriptPersistence, "appendAssistantTranscriptMessage")
        .mockImplementation(async (params) => {
          if (params.idempotencyKey !== runId + ":continuation-status") {
            return append(params);
          }
          appendEntered.resolve();
          await releaseAppend.promise;
          if (rejected) {
            return { ok: false, error: "Synthetic waiting reply storage failure" };
          }
          return append(params);
        });
      const settle = vi.fn(async (_delivered: boolean) => {});
      const frames: Array<Record<string, unknown>> = [];
      const record = (raw: RawData) => {
        const frame = JSON.parse(rawDataToString(raw));
        if (frame.event === "chat" && frame.payload?.runId === runId) {
          frames.push(frame.payload);
        }
      };
      ws.on("message", record);
      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        options = opts;
        if (queued) {
          opts?.turnAdoptionLifecycle?.onDeferred?.();
        } else {
          opts?.onAgentRunStart?.(runId);
          emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", yielded: true } });
        }
        if (!source) {
          opts?.onPendingContinuation?.({ settle });
        }
        return source ? { text: "Model fallback notice", isFallbackNotice: true } : payload;
      });
      try {
        expect(
          (
            await rpcReq(ws, "chat.send", {
              sessionKey: "main",
              message: "Research this and report when ready.",
              idempotencyKey: runId,
            })
          ).ok,
        ).toBe(true);
        await appendEntered.promise;
        expect.soft(settle, "queue admission is not public delivery").not.toHaveBeenCalled();
        releaseAppend.resolve();
        await requestExecution.waitForCompletion();
        const history = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", {
          sessionKey: "main",
        });
        expect(settle.mock.calls.map(([delivered]) => delivered)).toEqual(
          source ? [] : [!rejected],
        );
        if (queued) {
          expect(lifecycleWrites).toHaveLength(0);
        }
        if (rejected) {
          expect.soft(frames).toContainEqual(
            expect.objectContaining({
              state: "error",
              errorMessage: expect.stringContaining("Synthetic waiting reply storage failure"),
            }),
          );
          expect(JSON.stringify(history.payload)).not.toContain(acknowledgment);
          const replay = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "Research this and report when ready.",
            idempotencyKey: runId,
          });
          expect.soft(replay.ok).toBe(false);
          expect.soft(replay.payload).toMatchObject({ runId, status: "error" });
        } else {
          expect(JSON.stringify(history.payload)).toContain(acknowledgment);
          expect(frames).toContainEqual(
            expect.objectContaining({
              state: "final",
              message: expect.objectContaining({
                content: [{ type: "text", text: acknowledgment }],
              }),
            }),
          );
        }
      } finally {
        releaseAppend.resolve();
        await requestExecution.waitForCompletion();
        appendSpy.mockRestore();
        mediaSpy?.mockRestore();
        options?.turnAdoptionLifecycle?.onSettled?.();
        ws.off("message", record);
      }
    });
  });
});
