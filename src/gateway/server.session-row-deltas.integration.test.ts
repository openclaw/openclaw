import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { JSDOM } from "jsdom";
import { expect, onTestFinished, test, vi } from "vitest";
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
  },
  cleanup: async () => harness?.close(),
});

function expectFullSessionRowFrame(
  frame: EventFrame | undefined,
  legacy: EventFrame | undefined,
  decoder: GatewayChatEvents,
): void {
  if (!frame || !legacy) {
    throw new Error("Expected paired recovery frames");
  }
  expect(frame.payload).toHaveProperty("session.full");
  let decoded: EventFrame | undefined;
  decoder.dispatch(frame, (event) => {
    decoded = event;
  });
  expect(decoded?.payload).toEqual(legacy.payload);
}

test("capable and legacy sockets produce identical session payloads and consumer state", async () => {
  const readRetention = observeSessionEventRowRetention();
  const capable = await harness.openClient({
    caps: ["session-scoped-events", "session-row-deltas", "roster-message-bodies-optional"],
  });
  const legacy = await harness.openClient({ caps: ["session-scoped-events"] });
  const roster = await harness.openClient({
    caps: ["session-scoped-events", "session-row-deltas", "roster-message-bodies-optional"],
  });
  const keys = Array.from({ length: 5 }, (_, depth) => `agent:main:row-delta-depth-${depth}`);
  const key = keys.at(-1);
  if (!key) {
    throw new Error("Expected nested leaf");
  }
  const runId = "row-delta-controlled-turn";
  for (const [depth, childKey] of keys.entries()) {
    const created = await rpcReq(capable.ws, "sessions.create", {
      key: childKey,
      agentId: "main",
      visibility: "shared",
      ...(depth > 0 ? { parentSessionKey: keys[depth - 1], spawnDepth: depth } : {}),
    });
    expect(created.ok).toBe(true);
  }
  const projection = getSessionRowProjection(kernel.gatewayRequestContext);
  if (!projection) {
    throw new Error("Expected runtime session projection");
  }
  const drain = async (sockets = [capable.ws, legacy.ws, roster.ws]) => {
    await flushPendingSessionsChangedEvents(kernel.gatewayRequestContext);
    await drainSessionEventPublications(projection);
    // Replies order each socket's already handed-off event frames before comparison.
    for (const ws of sockets) {
      expect((await rpcReq(ws, "sessions.list", { agentId: "main", rowMode: "sidebar" })).ok).toBe(
        true,
      );
    }
  };
  await drain();
  for (const { ws } of [capable, legacy]) {
    expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    expect((await rpcReq(ws, "sessions.messages.subscribe", { key })).ok).toBe(true);
  }
  expect((await rpcReq(roster.ws, "sessions.subscribe", {})).ok).toBe(true);
  // Every exact kind retains bodies, including independently identified observers.
  for (const [depth, childKey] of keys.slice(0, -1).entries()) {
    expect(
      (
        await rpcReq(capable.ws, "sessions.messages.subscribe", {
          key: childKey,
          subscriptionId: `observer-${depth}`,
          ...(depth === 1 ? { mode: "narration" } : {}),
          ...(depth === 2 ? { includeApprovals: true } : {}),
        })
      ).ok,
    ).toBe(true);
  }
  const initial = await rpcReq<SessionsListResult>(legacy.ws, "sessions.list", {
    agentId: "main",
    rowMode: "sidebar",
  });
  if (!initial.payload) {
    throw new Error("Expected roster");
  }
  const legacyWire: string[] = [];
  const streams = [
    collectSessionRowFrames(capable.ws),
    collectSessionRowFrames(legacy.ws, legacyWire),
  ];
  const rosterWire: string[] = [];
  const rosterFrames = collectSessionRowFrames(roster.ws, rosterWire);
  let fullBodiesFrom = Number.POSITIVE_INFINITY;
  let finishSubagents = () => {};
  onTestFinished(() => finishSubagents());
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let dispatchFailure: unknown;
  const rootReleased = createDeferred<"settled" | "reset">();
  dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
    const { dispatcher, replyOptions } = args as Parameters<typeof dispatchInboundMessage>[0];
    try {
      const observeRelease = captureGatewayRootWorkReleaseObserver();
      if (!observeRelease) {
        throw new Error("Expected chat send root admission");
      }
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
          expect(
            (await rpcReq(roster.ws, "sessions.subscribe", { includeMessageBodies: true })).ok,
          ).toBe(true);
          fullBodiesFrom = rosterFrames.length;
          // A regular roster subscription must not reset the plugin preference.
          expect((await rpcReq(roster.ws, "sessions.subscribe", {})).ok).toBe(true);
        }
        const loaded = await loadGatewaySessionEntryReadOnlyAsync(childKey, { agentId: "main" });
        if (!loaded.entry) {
          throw new Error("Expected durable child");
        }
        const target = {
          agentId: "main",
          sessionKey: childKey,
          sessionId: loaded.entry.sessionId,
          storePath: loaded.storePath,
        };
        for (let index = 0; index < 2; index++) {
          const callId = `${depth}-${index}`;
          const messages = [
            {
              eventId: `${callId}:call`,
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: callId,
                    name: "exec",
                    arguments: { command: "rg rowDelta src/gateway" },
                  },
                ],
                timestamp: Date.now(),
              },
            },
            {
              eventId: `${callId}:result`,
              message: {
                role: "toolResult",
                toolCallId: callId,
                toolName: "exec",
                content: [{ type: "text", text: "Synthetic tool output.\n".repeat(300) }],
                timestamp: Date.now(),
              },
            },
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
                result: {
                  content: [{ type: "text", text: "Synthetic nested output.\n".repeat(300) }],
                },
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
        if (!fresh.entry) {
          throw new Error("Expected current child");
        }
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: childKey, storePath: fresh.storePath },
          {
            ...fresh.entry,
            activitySummary: {
              version: 1,
              formatRevision: 3,
              text: "Verified the nested tool run and transport receipts.",
              updatedAt: Date.now(),
              sessionId: fresh.entry.sessionId,
              lifecycleRevision: fresh.entry.lifecycleRevision,
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
          await broadcastSessionActivitySummary(
            { key: childKey, agentId: "main", storePath: fresh.storePath },
            {
              getSessionRowProjection: () => projection,
              broadcast: kernel.gatewayRequestContext.broadcast,
            },
          );
        }
      }
      const leaf = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
      if (!leaf.entry) {
        throw new Error("Expected leaf");
      }
      await persistSessionTranscriptTurn(
        {
          agentId: "main",
          sessionKey: key,
          sessionId: leaf.entry.sessionId,
          storePath: leaf.storePath,
        },
        {
          touchSessionEntry: true,
          runId,
          messages: [
            {
              eventId: `${runId}:reply`,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic final reply." }],
                stopReason: "stop",
                timestamp: Date.now(),
              },
            },
          ],
        },
      );
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
      finish();
    }
  });
  // Both recipient projections must observe the same producer clock, as one publication does.
  const producerClock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const sent = await rpcReq(capable.ws, "chat.send", {
    sessionKey: key,
    message: "Synthetic controlled nested tool run.",
    idempotencyKey: runId,
  });
  expect(sent.ok).toBe(true);
  await completed;
  if (dispatchFailure !== undefined) {
    throw new Error("Session row proof dispatch failed", { cause: dispatchFailure });
  }
  expect(await rootReleased.promise).toBe("settled");
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  await drain();
  producerClock.mockRestore();
  const [encoded, baseline] = streams;
  if (!encoded || !baseline) {
    throw new Error("Expected paired socket streams");
  }
  expect(encoded.length).toBeGreaterThan(20);
  expect(encoded).toHaveLength(baseline.length);
  const reconnect = vi.fn();
  const decoder = new GatewayChatEvents(reconnect);
  const rosterDecoder = new GatewayChatEvents(reconnect);
  const bodyMeasurements: { before: number; after: number; wireAfter: number; role: unknown }[] =
    [];
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
  const initialRows = initial.payload;
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
    const original = baseline[index];
    if (!original) {
      throw new Error("Missing corresponding legacy frame");
    }
    patches += JSON.stringify(frame.payload).includes('"base":') ? 1 : 0;
    let decoded: EventFrame | undefined;
    decoder.dispatch(frame, (event) => {
      decoded = event;
    });
    expect(decoded?.payload, `frame ${index} ${frame.event}`).toEqual(original.payload);
    if (!decoded) {
      throw new Error("Decoder discarded a valid stream");
    }
    const rosterFrame = rosterFrames[index];
    if (!rosterFrame) {
      throw new Error("Missing corresponding roster frame");
    }
    let rosterDecoded: EventFrame | undefined;
    rosterDecoder.dispatch(rosterFrame, (event) => {
      rosterDecoded = event;
    });
    const expectedPayload = { ...(decoded.payload as Record<string, unknown>) };
    if (frame.event === "session.message") {
      expect(original.payload).toHaveProperty("message");
      expect(decoded.payload).toHaveProperty("message");
      if (index < fullBodiesFrom) {
        delete expectedPayload.message;
        expect(rosterFrame.payload).not.toHaveProperty("message");
        const withoutBody = { ...(original.payload as Record<string, unknown>) };
        const message = withoutBody.message as { role?: unknown };
        delete withoutBody.message;
        bodyMeasurements.push({
          before: Buffer.byteLength(legacyWire[index] ?? ""),
          after: Buffer.byteLength(JSON.stringify({ ...original, payload: withoutBody })),
          wireAfter: Buffer.byteLength(rosterWire[index] ?? ""),
          role: message.role,
        });
      } else {
        completeRosterMessages += 1;
      }
      if (bodyMeasurements.length === 1) {
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
  expect(bodyMeasurements.length).toBeGreaterThan(0);
  expect(completeRosterMessages).toBeGreaterThan(0);
  console.log("ROSTER_MESSAGE_REAL_SOCKET_BYTES", JSON.stringify(bodyMeasurements));
  expect(patches).toBeGreaterThan(10);
  expect(reconnect).not.toHaveBeenCalled();
  expect(consumers[0]?.snapshot().chat.messages.length).toBeGreaterThan(0);
  const categories = [
    [
      "recap",
      (event: EventFrame) => (event.payload as { reason?: string }).reason === "activity-summary",
    ],
    [
      "nested-tool",
      (event: EventFrame) =>
        event.event === "session.message" &&
        (event.payload as { message?: { role?: string } }).message?.role === "custom",
    ],
    [
      "changed",
      (event: EventFrame) =>
        event.event === "sessions.changed" &&
        (event.payload as { reason?: string }).reason !== "activity-summary",
    ],
  ] as const;
  const measurements = Object.fromEntries(
    categories.map(([name, matches]) => {
      const index = baseline.findLastIndex(matches);
      if (index < 0) {
        throw new Error(`Expected measured ${name} frame`);
      }
      return [
        name,
        {
          before: Buffer.byteLength(JSON.stringify(baseline[index])),
          after: Buffer.byteLength(JSON.stringify(encoded[index])),
        },
      ];
    }),
  );
  console.log("SESSION_ROW_DELTA_REAL_SOCKET_BYTES", JSON.stringify(measurements));
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
  expect((await rpcReq(legacy.ws, "sessions.messages.unsubscribe", { key })).ok).toBe(true);
  expect(await readRetention()).toEqual(retainedBeforeUnsubscribe);
  const summaryTarget = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
  const publishRecap = () =>
    broadcastSessionActivitySummary(
      { key, agentId: "main", storePath: summaryTarget.storePath },
      {
        getSessionRowProjection: () => projection,
        broadcast: kernel.gatewayRequestContext.broadcast,
      },
    );
  await publishRecap();
  await drain();
  const afterUnsubscribe = encoded.at(-1);
  if (!afterUnsubscribe) {
    throw new Error("Expected warm recap after unsubscribe");
  }
  expect(afterUnsubscribe.payload).toHaveProperty("session.base");
  let decodedAfterUnsubscribe: EventFrame | undefined;
  decoder.dispatch(afterUnsubscribe, (event) => {
    decodedAfterUnsubscribe = event;
  });
  expect(decodedAfterUnsubscribe?.payload).toEqual(baseline.at(-1)?.payload);
  await closeSessionRowSocket(roster.ws);
  await closeSessionRowSocket(capable.ws);
  const reopened = await harness.openClient({
    caps: ["session-scoped-events", "session-row-deltas"],
  });
  const reopenedFrames = collectSessionRowFrames(reopened.ws);
  expect((await rpcReq(reopened.ws, "sessions.subscribe", {})).ok).toBe(true);
  const reopenedDecoder = new GatewayChatEvents(reconnect);
  await publishRecap();
  await drain([reopened.ws, legacy.ws]);
  expectFullSessionRowFrame(reopenedFrames.at(-1), baseline.at(-1), reopenedDecoder);
  await publishRecap();
  await drain([reopened.ws, legacy.ws]);
  const reverseOrderWarmFrame = reopenedFrames.at(-1);
  if (!reverseOrderWarmFrame) {
    throw new Error("Expected warm frame with legacy recipient first");
  }
  expect(reverseOrderWarmFrame.payload).toHaveProperty("session.base");
  let reverseOrderDecoded: EventFrame | undefined;
  reopenedDecoder.dispatch(reverseOrderWarmFrame, (event) => {
    reverseOrderDecoded = event;
  });
  expect(reverseOrderDecoded?.payload).toEqual(baseline.at(-1)?.payload);
  expect(reconnect).not.toHaveBeenCalled();
  await Promise.all([closeSessionRowSocket(reopened.ws), closeSessionRowSocket(legacy.ws)]);
  await vi.waitFor(async () =>
    expect(await readRetention()).toEqual({ entries: 0, estimatedBytes: 0 }),
  );
});
