import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import type { WebSocket, RawData } from "ws";
import { mergeChatStreamMessage } from "../../packages/gateway-client/src/chat-stream-message.js";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import {
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  type FollowupRun,
} from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { bindReplySourceToFollowup } from "../auto-reply/reply/reply-source-binding.js";
import { emitAgentEvent, type AgentEventStream } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { captureSessionControllerSourceSettlement } from "../sessions/session-controller.mailbox.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import { createPreparedLifecycleWriteTracker } from "./session-lifecycle-state.test-support.js";
import { dispatchInboundMessageMock, onceMessage, rpcReq } from "./test-helpers.js";

const CHAT_RESPONSE_TIMEOUT_MS = 10_000;
const ANSWER = "late answer arrived over the live WebSocket";
const completedOutcome = { kind: "completed" as const };
const canvasCompleted = { ...completedOutcome, allowCanvasOnly: true as const };
let ws: WebSocket;
let lifecycleWrites: ReturnType<typeof createPreparedLifecycleWriteTracker>;
const gatewaySuite = installGatewayServerChatTestSuite(
  (started) => {
    ws = started.ws;
  },
  // Synthetic events lack a request scope; join their producer before draining writers.
  () => lifecycleWrites.drain(),
);

describe("queued WebChat follow-up delivery", () => {
  let observedFollowupRunId: string | undefined;
  beforeEach(async () => {
    lifecycleWrites = createPreparedLifecycleWriteTracker();
    observedFollowupRunId = undefined;
    const prepareLifecycle = lifecycleState.prepareGatewaySessionLifecycleEvent;
    const persistenceSpy = vi
      .spyOn(lifecycleState, "prepareGatewaySessionLifecycleEvent")
      .mockImplementation((params) => {
        const persist = prepareLifecycle(params);
        if (params.event.runId !== observedFollowupRunId) {
          return persist;
        }
        return lifecycleWrites.track(persist);
      });
    onTestFinished(() => {
      persistenceSpy.mockRestore();
    });
  });
  const { withMainSessionStore } = gatewaySuite;

  test.each([
    { name: "text", completion: completedOutcome, state: "final" },
    { name: "canvas", completion: canvasCompleted, state: "final" },
    { name: "silent-canvas", completion: canvasCompleted, state: "final" },
    { name: "suppressed-canvas", completion: completedOutcome, state: "final" },
    {
      name: "timeout",
      completion: {
        kind: "failed" as const,
        error: "provider timed out",
        errorKind: "timeout" as const,
        stopReason: "timeout",
      },
      state: "error",
    },
    {
      name: "abort",
      completion: { kind: "aborted" as const, stopReason: "restart" },
      state: "aborted",
    },
  ])(
    "keeps a queued WebChat $name pending until its follow-up completes",
    async ({ name, completion, state }) => {
      await withMainSessionStore(async () => {
        let options: InternalGetReplyOptions | undefined;
        let queued: FollowupRun | undefined;
        const releaseDispatch = createDeferred();
        dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
          options = (args as { replyOptions?: InternalGetReplyOptions }).replyOptions;
          queued = createQueueTestRun({
            prompt: "queue a reply while the previous run is active",
            originatingChannel: "webchat",
          });
          queued.turnAdoptionLifecycle = options?.turnAdoptionLifecycle;
          queued.run = {
            ...queued.run,
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionId: "sess-main",
          };
          expect(bindReplySourceToFollowup(options, queued)).toBeDefined();
          expect(
            enqueueFollowupRun(
              "agent:main:main",
              queued,
              { mode: "followup" },
              "none",
              undefined,
              false,
            ),
          ).toBe(true);
          await releaseDispatch.promise;
          return {};
        });

        const sourceRunId = `idem-live-webchat-late-source-${name}`;
        const canvasOnly = name.includes("canvas");
        const terminalFrames: unknown[] = [];
        const deltaFrames: Extract<ChatEvent, { state: "delta" }>[] = [];
        const recordFollowup = (raw: RawData) => {
          const frame = JSON.parse(rawDataToString(raw));
          if (frame.event === "chat" && frame.payload?.runId === sourceRunId) {
            if (frame.payload.state === "delta") {
              deltaFrames.push(frame.payload);
            } else {
              terminalFrames.push(frame.payload);
            }
          }
        };
        ws.on("message", recordFollowup);
        try {
          const response = await rpcReq(ws, "chat.send", {
            sessionKey: "main",
            message: "queue a reply while the previous run is active",
            idempotencyKey: sourceRunId,
          });
          expect(response.ok).toBe(true);
          await vi.waitFor(
            () => expect(options?.onQueuedFollowupReplyBatch).toBeTypeOf("function"),
            { interval: 1 },
          );
          releaseDispatch.resolve();
          await gatewaySuite.requestExecution.waitForDispatch(sourceRunId);
          await rpcReq(ws, "health", {});
          expect(terminalFrames).toHaveLength(0);

          const followupRunId = `idem-live-webchat-late-followup-${name}`;
          const emit = (stream: AgentEventStream, data: Record<string, unknown>) =>
            emitAgentEvent({ runId: followupRunId, stream, data });
          observedFollowupRunId = followupRunId;
          const queuedFinal = onceMessage(
            ws,
            (event) =>
              event.type === "event" &&
              event.event === "chat" &&
              event.payload?.state === state &&
              event.payload?.runId === sourceRunId,
            CHAT_RESPONSE_TIMEOUT_MS,
          );
          registerAgentRunContext(followupRunId, { sessionKey: "main" });
          registerAgentRunContext(followupRunId, { completionSource: "reply-dispatch" });
          options?.onAgentRunStart?.(followupRunId);
          if (canvasOnly || name === "abort") {
            emit("tool", {
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
          emit("assistant", { text: canvasOnly ? "" : ANSWER });
          if (completion.kind === "failed" || completion.kind === "aborted") {
            emit("assistant", {
              text: `${ANSWER} tail`,
              delta: " tail",
            });
          }
          emit("lifecycle", {
            phase: completion.kind === "failed" ? "error" : "end",
            executionSettled: true,
            ...(name === "silent-canvas" ? { terminalReply: { disposition: "silent" } } : {}),
            ...(completion.kind === "aborted" ? { aborted: true, stopReason: "restart" } : {}),
          });
          await options?.onQueuedFollowupReplyBatch?.({
            kind: "queued-followup",
            completion: { ...completion },
            runId: followupRunId,
            originatingChannel: "webchat",
            payloads: name === "text" ? [{ text: ANSWER }] : [],
          });
          const completed = await queuedFinal;
          await rpcReq(ws, "health", {});
          expect(completed.payload?.state).toBe(state);
          if (name === "timeout") {
            expect(completed.payload).toMatchObject({
              errorKind: "timeout",
              stopReason: "timeout",
            });
          }
          if (name === "abort") {
            expect(completed.payload).toMatchObject({ stopReason: "restart" });
          }
          if (name === "canvas" || name === "silent-canvas" || name === "abort") {
            expect(completed.payload?.message).toMatchObject({
              content: expect.arrayContaining([expect.objectContaining({ type: "canvas" })]),
            });
          }
          if (name === "suppressed-canvas") {
            expect(completed.payload?.message).toBeUndefined();
          }
          if (name === "text") {
            expect(completed.payload?.message).toMatchObject({
              content: [
                { type: "text", text: "working" },
                { type: "text", text: ANSWER },
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
              content: expect.arrayContaining([{ type: "text", text: `${ANSWER} tail` }]),
            });
          }
          if (completion.kind === "aborted") {
            expect(completed.payload?.message).toMatchObject({
              content: expect.arrayContaining([{ type: "text", text: `${ANSWER} tail` }]),
            });
          }
        } finally {
          releaseDispatch.resolve();
          ws.off("message", recordFollowup);
          if (queued) {
            completeFollowupRunLifecycle(queued);
            if (queued.controllerInput) {
              await captureSessionControllerSourceSettlement(queued.controllerInput);
            }
          }
        }
      });
    },
  );
});
