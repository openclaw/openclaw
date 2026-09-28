import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket, RawData } from "ws";
import { mergeChatStreamMessage } from "../../packages/gateway-client/src/chat-stream-message.js";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { createMainChatSessionStoreFixture } from "./server.chat-session-store.test-support.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
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
  beforeEach(async () => {
    dispatchInboundMessageMock.mockReset();
    requestExecution = await observeGatewayRunExecution();
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
    { name: "empty", completion: { kind: "completed" as const }, payloads: [], state: "final" },
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
      name: "failure",
      completion: { kind: "failed" as const, error: "follow-up failed" },
      payloads: [],
      state: "error",
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
});
