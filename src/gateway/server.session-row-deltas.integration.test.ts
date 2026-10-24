import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { JSDOM } from "jsdom";
import { expect, onTestFinished, test, vi } from "vitest";
import type { WebSocket } from "ws";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import type { SessionsListResult } from "../../ui/src/api/types.ts";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.ts";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  captureGatewayRootWorkReleaseObserver,
  getActiveGatewayRootWorkCount,
} from "../process/gateway-work-admission.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { observeSessionEventRowRetention } from "./session-event-row-retention.test-support.js";
import { startSessionRowDeltaSubagents } from "./session-row-delta-run.test-support.js";
import {
  closeSessionRowSocket,
  collectSessionRowFrames,
} from "./session-row-delta-sockets.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.js";

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    kernel = await captureGatewayKernel(async () => {
      harness = await startGatewayServerHarness();
    });
  },
  cleanup: async () => harness?.close(),
});

function decodeFrame(decoder: GatewayChatEvents, frame: EventFrame): EventFrame {
  let decoded: EventFrame | undefined;
  decoder.dispatch(frame, (event) => {
    decoded = event;
  });
  return expectDefined(decoded, "decoded frame");
}

function expectSessionRowFrame(
  frame: EventFrame | undefined,
  legacy: EventFrame | undefined,
  decoder: GatewayChatEvents,
  kind: "full" | "base",
): void {
  const encoded = expectDefined(frame, "encoded frame");
  expect(encoded.payload).toHaveProperty(`session.${kind}`);
  expect(decodeFrame(decoder, encoded).payload).toEqual(
    expectDefined(legacy, "legacy frame").payload,
  );
}

async function request(ws: WebSocket, method: string, params: unknown = {}) {
  const response = await rpcReq(ws, method, params);
  expect(response.ok).toBe(true);
  return response.payload;
}

async function sessionTarget(sessionKey: string) {
  const loaded = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, { agentId: "main" });
  return {
    agentId: "main",
    sessionKey,
    storePath: loaded.storePath,
    sessionId: expectDefined(loaded.entry, "durable session").sessionId,
  };
}

const textContent = (text: string) => [{ type: "text", text }];
const transcriptEvent = (
  eventId: string,
  role: string,
  content: unknown[],
  fields: Record<string, unknown> = {},
) => ({
  eventId,
  message: { role, content, timestamp: Date.now(), ...fields },
});

test("capable and legacy sockets produce identical session payloads and consumer state", async () => {
  const readRetention = observeSessionEventRowRetention();
  const deltaCaps = [
    "session-scoped-events",
    "session-row-deltas",
    "session-event-field-refs",
    "roster-message-bodies-optional",
  ];
  const capable = await harness.openClient({ caps: deltaCaps });
  const legacy = await harness.openClient({ caps: ["session-scoped-events"] });
  const roster = await harness.openClient({ caps: deltaCaps });
  const keys = Array.from({ length: 5 }, (_, depth) => `agent:main:row-delta-depth-${depth}`);
  const key = expectDefined(keys.at(-1), "nested leaf");
  const runId = "row-delta-controlled-turn";
  for (const [depth, childKey] of keys.entries()) {
    await request(capable.ws, "sessions.create", {
      key: childKey,
      agentId: "main",
      visibility: "shared",
      ...(depth > 0 ? { parentSessionKey: keys[depth - 1], spawnDepth: depth } : {}),
    });
  }
  const projection = expectDefined(
    getSessionRowProjection(kernel.gatewayRequestContext),
    "projection",
  );
  const summaryContext = {
    getSessionRowProjection: () => projection,
    broadcast: kernel.gatewayRequestContext.broadcast,
  };
  const publishSummary = (target: Awaited<ReturnType<typeof sessionTarget>>) =>
    broadcastSessionActivitySummary(
      { key: target.sessionKey, agentId: "main", storePath: target.storePath },
      summaryContext,
    );
  const drain = async (sockets = [capable.ws, legacy.ws, roster.ws]) => {
    await flushPendingSessionsChangedEvents(kernel.gatewayRequestContext);
    await drainSessionEventPublications(projection);
    // Replies order each socket's already handed-off event frames before comparison.
    for (const ws of sockets) {
      await request(ws, "sessions.list", { agentId: "main", rowMode: "sidebar" });
    }
  };
  await drain();
  for (const { ws } of [capable, legacy]) {
    await request(ws, "sessions.subscribe");
    await request(ws, "sessions.messages.subscribe", { key });
  }
  await request(roster.ws, "sessions.subscribe");
  // Every exact kind retains bodies, including independently identified observers.
  for (const [depth, childKey] of keys.slice(0, -1).entries()) {
    await request(capable.ws, "sessions.messages.subscribe", {
      key: childKey,
      subscriptionId: `observer-${depth}`,
      ...(depth === 1 ? { mode: "narration" } : {}),
      ...(depth === 2 ? { includeApprovals: true } : {}),
    });
  }
  const initial = await rpcReq<SessionsListResult>(legacy.ws, "sessions.list", {
    agentId: "main",
    rowMode: "sidebar",
  });
  const initialRows = expectDefined(initial.payload, "roster");
  const streams = [collectSessionRowFrames(capable.ws), collectSessionRowFrames(legacy.ws)];
  const rosterFrames = collectSessionRowFrames(roster.ws);
  let fullBodiesFrom = Number.POSITIVE_INFINITY;
  let finishSubagents = () => {};
  onTestFinished(() => finishSubagents());
  const completed = createDeferred();
  let dispatchFailure: unknown;
  const rootReleased = createDeferred<"settled" | "reset">();
  dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
    const { dispatcher, replyOptions } = args as Parameters<typeof dispatchInboundMessage>[0];
    try {
      const observeRelease = expectDefined(
        captureGatewayRootWorkReleaseObserver(),
        "root admission",
      );
      observeRelease(rootReleased.resolve);
      const userReceived = onceMessage(legacy.ws, (frame) => {
        const message = frame.payload?.message;
        return (
          frame.event === "session.message" &&
          frame.payload?.sessionKey === key &&
          isRecord(message) &&
          message.role === "user"
        );
      });
      await Promise.all([
        replyOptions?.userTurnTranscriptRecorder?.persistApproved(),
        userReceived,
      ]);
      await replyOptions?.onAgentRunStart?.(runId);
      finishSubagents = await startSessionRowDeltaSubagents(keys);
      emitAgentEvent({
        runId,
        sessionKey: key,
        agentId: "main",
        stream: "lifecycle",
        data: { phase: "start", startedAt: Date.now() },
      });
      for (const [depth, childKey] of keys.entries()) {
        if (depth === 2) {
          await drain();
          expect(rosterFrames.filter((frame) => frame.event === "session.message")).toHaveLength(
            13,
          );
          await request(roster.ws, "sessions.subscribe", { includeMessageBodies: true });
          fullBodiesFrom = rosterFrames.length;
          // A regular roster subscription must not reset the plugin preference.
          await request(roster.ws, "sessions.subscribe");
        }
        const target = await sessionTarget(childKey);
        for (let index = 0; index < 2; index++) {
          const callId = `${depth}-${index}`;
          const messages = [
            transcriptEvent(`${callId}:call`, "assistant", [
              {
                type: "toolCall",
                id: callId,
                name: "exec",
                arguments: { command: "rg rowDelta src/gateway" },
              },
            ]),
            transcriptEvent(
              `${callId}:result`,
              "toolResult",
              textContent("Synthetic tool output.\n".repeat(300)),
              {
                toolCallId: callId,
                toolName: "exec",
              },
            ),
            {
              eventId: `${callId}:nested`,
              message: createNestedToolActivity({
                runId,
                scopeId: `scope-${depth}`,
                afterEntryId: null,
                startOrder: index,
                parentToolCallId: callId,
                toolCallId: `${callId}-nested`,
                toolName: "read",
                input: { path: "src/gateway/server-session-events.ts" },
                result: { content: textContent("Synthetic nested output.\n".repeat(300)) },
                isError: false,
                startedAt: Date.now(),
                timestamp: Date.now(),
              }),
            },
          ];
          // This tests individual message bodies; bursts intentionally coalesce into a reset.
          for (const message of messages) {
            let received: Promise<unknown> | undefined;
            await persistSessionTranscriptTurn(target, {
              touchSessionEntry: true,
              runId,
              messages: [message],
              onMessageCommitted: ({ messageId }) => {
                received = onceMessage(
                  roster.ws,
                  (frame) =>
                    frame.event === "session.message" && frame.payload?.messageId === messageId,
                );
                void received.catch(() => undefined);
              },
            });
            if (!received) {
              throw new Error("Expected a committed tool message receipt");
            }
            await received;
          }
        }
        const fresh = await loadGatewaySessionEntryReadOnlyAsync(childKey, { agentId: "main" });
        const entry = expectDefined(fresh.entry, "current child");
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: childKey, storePath: fresh.storePath },
          {
            ...entry,
            activitySummary: {
              version: 1,
              formatRevision: 3,
              text: "Verified the nested tool run and transport receipts.",
              updatedAt: Date.now(),
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              generation: null,
              maxSeq: null,
              leafEntryId: null,
              coveredMessages: 0,
              totalMessages: 0,
              omittedContent: false,
            },
          },
        );
        for (let repeat = 0; repeat < 2; repeat++) {
          await publishSummary({ ...target, storePath: fresh.storePath });
        }
      }
      const leaf = await sessionTarget(key);
      await persistSessionTranscriptTurn(leaf, {
        touchSessionEntry: true,
        runId,
        messages: [
          transcriptEvent(`${runId}:reply`, "assistant", textContent("Synthetic final reply."), {
            stopReason: "stop",
          }),
        ],
      });
      const queuedFinal = dispatcher.sendFinalReply({ text: "Synthetic final reply." });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      emitAgentEvent({
        runId,
        sessionKey: key,
        agentId: "main",
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
      return { queuedFinal, counts: dispatcher.getQueuedCounts() };
    } catch (error) {
      dispatchFailure = error;
      throw error;
    } finally {
      completed.resolve();
    }
  });
  // Both recipient projections must observe the same producer clock, as one publication does.
  const producerClock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  await request(capable.ws, "chat.send", {
    sessionKey: key,
    message: "Synthetic controlled nested tool run.",
    idempotencyKey: runId,
  });
  await completed.promise;
  if (dispatchFailure !== undefined) {
    throw new Error("Session row proof dispatch failed", { cause: dispatchFailure });
  }
  expect(await rootReleased.promise).toBe("settled");
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  await drain();
  producerClock.mockRestore();
  const encoded = expectDefined(streams[0], "encoded stream");
  const baseline = expectDefined(streams[1], "legacy stream");
  expect(encoded.length).toBeGreaterThan(20);
  expect(encoded).toHaveLength(baseline.length);
  const reconnect = vi.fn();
  const decoder = new GatewayChatEvents(reconnect);
  const rosterDecoder = new GatewayChatEvents(reconnect);
  let omittedRosterMessages = 0;
  let completeRosterMessages = 0;
  expect(rosterFrames).toHaveLength(baseline.length);
  // Retain Node's typed-array realm for SQLite RPC while UI owners register their elements.
  const dom = new JSDOM("<body></body>", { url: "http://localhost", pretendToBeVisual: true });
  let disposeConsumers = () => {};
  onTestFinished(() => {
    disposeConsumers();
    vi.unstubAllGlobals();
    dom.window.close();
  });
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLSelectElement",
    "HTMLDialogElement",
    "customElements",
    "Element",
    "Node",
    "Text",
    "Document",
    "DocumentFragment",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "EventTarget",
    "navigator",
    "localStorage",
  ] as const) {
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  }
  const { createSessionRowDeltaConsumers } =
    await import("../../ui/src/test-helpers/session-row-delta-consumers.ts");
  // Receipt sampling belongs to each UI owner; both streams observe the same client clock.
  const clientClock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const consumers = await Promise.all(
    [0, 1].map(() => createSessionRowDeltaConsumers(structuredClone(initialRows), key)),
  );
  onTestFinished(() => {
    clientClock.mockRestore();
  });
  disposeConsumers = () => consumers.forEach((consumer) => consumer.dispose());
  let patches = 0;
  for (const [index, frame] of encoded.entries()) {
    const original = expectDefined(baseline[index], "corresponding legacy frame");
    patches += JSON.stringify(frame.payload).includes('"base":') ? 1 : 0;
    const decoded = decodeFrame(decoder, frame);
    expect(decoded.payload, `frame ${index} ${frame.event}`).toEqual(original.payload);
    const rosterFrame = expectDefined(rosterFrames[index], "corresponding roster frame");
    const rosterDecoded = decodeFrame(rosterDecoder, rosterFrame);
    const expectedPayload = { ...(decoded.payload as Record<string, unknown>) };
    if (frame.event === "session.message") {
      expect(original.payload).toHaveProperty("message");
      expect(decoded.payload).toHaveProperty("message");
      if (index < fullBodiesFrom) {
        delete expectedPayload.message;
        expect(rosterFrame.payload).not.toHaveProperty("message");
        omittedRosterMessages++;
      } else {
        completeRosterMessages += 1;
      }
      if (omittedRosterMessages === 1) {
        // Decoding preserves the full envelope, independent of object property order.
        expect({ ...decoded, seq: original.seq }).toEqual(original);
      }
    }
    expect(rosterDecoded?.payload, `roster frame ${index} ${frame.event}`).toEqual(expectedPayload);
    consumers[0]?.apply(decoded);
    consumers[1]?.apply(original);
    expect(consumers[0]?.snapshot(), `consumer state after frame ${index}`).toEqual(
      consumers[1]?.snapshot(),
    );
  }
  expect(omittedRosterMessages).toBeGreaterThan(0);
  expect(completeRosterMessages).toBeGreaterThan(0);
  expect(patches).toBeGreaterThan(10);
  expect(reconnect).not.toHaveBeenCalled();
  expect(consumers[0]?.snapshot().chat.messages.length).toBeGreaterThan(0);
  expect(
    baseline.some(
      (frame) => isRecord(frame.payload) && frame.payload.reason === "activity-summary",
    ),
  ).toBe(true);
  expect(
    baseline.some(
      (frame) =>
        frame.event === "session.message" &&
        isRecord(frame.payload) &&
        isRecord(frame.payload.message) &&
        frame.payload.message.role === "custom",
    ),
  ).toBe(true);
  expect(
    baseline.some(
      (frame) =>
        frame.event === "sessions.changed" &&
        (!isRecord(frame.payload) || frame.payload.reason !== "activity-summary"),
    ),
  ).toBe(true);
  const retainedBeforeUnsubscribe = await readRetention();
  expect(retainedBeforeUnsubscribe.entries).toBeGreaterThan(0);
  await decoder.request(
    createTestGatewayClient(async (method, params) => {
      const result = await rpcReq(capable.ws, method, params);
      if (!result.ok || result.payload == null) {
        throw new Error(`Expected successful ${method} response`);
      }
      return result.payload;
    }),
    "sessions.messages.unsubscribe",
    { key },
  );
  await request(legacy.ws, "sessions.messages.unsubscribe", { key });
  expect(await readRetention()).toEqual(retainedBeforeUnsubscribe);
  const summaryTarget = await sessionTarget(key);
  const publishRecap = () => publishSummary(summaryTarget);
  await publishRecap();
  await drain();
  expectSessionRowFrame(encoded.at(-1), baseline.at(-1), decoder, "base");
  await closeSessionRowSocket(roster.ws);
  await closeSessionRowSocket(capable.ws);
  const reopened = await harness.openClient({
    caps: ["session-scoped-events", "session-row-deltas"],
  });
  const reopenedFrames = collectSessionRowFrames(reopened.ws);
  await request(reopened.ws, "sessions.subscribe");
  const reopenedDecoder = new GatewayChatEvents(reconnect);
  await publishRecap();
  await drain([reopened.ws, legacy.ws]);
  expectSessionRowFrame(reopenedFrames.at(-1), baseline.at(-1), reopenedDecoder, "full");
  await publishRecap();
  await drain([reopened.ws, legacy.ws]);
  expectSessionRowFrame(reopenedFrames.at(-1), baseline.at(-1), reopenedDecoder, "base");
  expect(reconnect).not.toHaveBeenCalled();
  await Promise.all([closeSessionRowSocket(reopened.ws), closeSessionRowSocket(legacy.ws)]);
  await vi.waitFor(async () =>
    expect(await readRetention()).toEqual({ entries: 0, estimatedBytes: 0 }),
  );
});
