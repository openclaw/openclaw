import { expect, onTestFinished, test, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { observeSessionEventRowRetention } from "./session-event-row-retention.test-support.js";
import { collectSessionRowFrames } from "./session-row-delta-sockets.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";
import { dispatchInboundMessageMock, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

let harness: GatewayServerHarness;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
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

test("ordinary fact changes keep warm wire rows across three real sockets", async () => {
  const resets: Array<{ cause: string; count: number }> = [];
  const readRetention = observeSessionEventRowRetention(({ cause, count }) =>
    resets.push({ cause, count }),
  );
  const sockets = await Promise.all([
    harness.openClient({ caps: ["session-scoped-events", "session-row-deltas"] }),
    harness.openClient({ caps: ["session-scoped-events", "session-row-deltas"] }),
    harness.openClient({ caps: ["session-scoped-events"] }),
  ]);
  const keys = [
    "agent:main:baseline-parent",
    "agent:main:baseline-child",
    "agent:main:baseline-other",
  ];
  const key = keys[1]!;
  const context = kernel.gatewayRequestContext;
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Expected runtime session projection");
  }
  const drain = async () => {
    await flushPendingSessionsChangedEvents(context);
    await drainSessionEventPublications(projection);
    for (const { ws } of sockets) {
      expect((await rpcReq(ws, "sessions.list", { agentId: "main", rowMode: "sidebar" })).ok).toBe(
        true,
      );
    }
  };
  for (const [index, sessionKey] of keys.entries()) {
    expect(
      (
        await rpcReq(sockets[0]!.ws, "sessions.create", {
          key: sessionKey,
          agentId: "main",
          visibility: "shared",
          ...(index === 1 ? { parentSessionKey: keys[0], spawnDepth: 1 } : {}),
        })
      ).ok,
    ).toBe(true);
  }
  await drain();
  for (const { ws } of sockets) {
    expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    expect((await rpcReq(ws, "sessions.messages.subscribe", { key })).ok).toBe(true);
  }
  const streams = sockets.map(({ ws }) => collectSessionRowFrames(ws));
  const waitForPhase = async (phase: string) => {
    await vi.waitFor(() =>
      expect(
        streams[2]!.some(
          (frame) =>
            frame.event === "sessions.changed" &&
            (frame.payload as { phase?: string }).phase === phase,
        ),
      ).toBe(true),
    );
  };
  const recap = async (sessionKey: string) => {
    const target = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, { agentId: "main" });
    await broadcastSessionActivitySummary(
      { key: sessionKey, agentId: "main", storePath: target.storePath },
      {
        getSessionRowProjection: () => projection,
        broadcast: context.broadcast,
      },
    );
  };
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  onTestFinished(() => clock.mockRestore());
  for (const sessionKey of keys) {
    await recap(sessionKey);
  }
  await drain();
  const warmCount = streams[0]!.length;
  const runId = "baseline-controlled-turn";
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
    const { dispatcher, replyOptions } = args as Parameters<typeof dispatchInboundMessage>[0];
    try {
      await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      await drain();
      await replyOptions?.onAgentRunStart?.(runId);
      await drain();
      emitAgentEvent({
        runId,
        sessionKey: key,
        agentId: "main",
        stream: "lifecycle",
        data: { phase: "start", startedAt: Date.now() },
      });
      await waitForPhase("start");
      await drain();
      const queuedFinal = dispatcher.sendFinalReply({ text: "Synthetic baseline reply." });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      emitAgentEvent({
        runId,
        sessionKey: key,
        agentId: "main",
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
      await waitForPhase("end");
      await drain();
      return { queuedFinal, counts: dispatcher.getQueuedCounts() };
    } finally {
      complete();
    }
  });
  expect(
    (
      await rpcReq(sockets[0]!.ws, "chat.send", {
        sessionKey: key,
        message: "Synthetic baseline turn.",
        idempotencyKey: runId,
      })
    ).ok,
  ).toBe(true);
  await completed;
  await vi.waitFor(() =>
    expect(
      streams[2]!.some(
        (frame) => (frame.payload as { reason?: string }).reason === "agent.input.settled",
      ),
    ).toBe(true),
  );
  await drain();

  const loaded = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
  if (!loaded.entry) {
    throw new Error("Expected durable session");
  }
  const placement = kernel.workerEnvironmentStartup?.placementStore;
  if (!placement) {
    throw new Error("Expected placement owner");
  }
  await placement.startDispatch({
    sessionId: loaded.entry.sessionId,
    sessionKey: key,
    agentId: "main",
  });
  emitSessionsChanged(
    context,
    { sessionKey: key, agentId: "main", reason: "placement" },
    { accessChanged: false, rowScope: "runtime" },
  );
  await drain();
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: key, storePath: loaded.storePath },
    {
      ...loaded.entry,
      modelOverride: "synthetic-model",
      providerOverride: "synthetic",
    },
  );
  emitSessionsChanged(context, { sessionKey: key, agentId: "main", reason: "patch" });
  await drain();
  const current = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
  if (!current.entry) {
    throw new Error("Expected current session");
  }
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: key, storePath: current.storePath },
    {
      ...current.entry,
      activitySummary: {
        version: 1,
        formatRevision: 3,
        text: "Synthetic recap after ordinary facts changed.",
        updatedAt: Date.now(),
        sessionId: current.entry.sessionId,
        lifecycleRevision: current.entry.lifecycleRevision,
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    },
  );
  await recap(key);
  await drain();

  // A sessionless run uses the real registry's broad agent-runs facts notification.
  registerAgentRunContext("baseline-sessionless", { agentId: "main" });
  onTestFinished(() => clearAgentRunContext("baseline-sessionless"));
  await drain();
  await recap(key);
  await drain();
  // A deletion of another session reaches the projection's ancestor invalidation hook.
  expect((await rpcReq(sockets[0]!.ws, "sessions.delete", { key: keys[2] })).ok).toBe(true);
  await drain();
  await recap(key);
  await drain();

  const baseline = streams[2]!;
  const measurements: Array<Record<string, unknown>> = [];
  for (const encoded of streams.slice(0, 2)) {
    expect(encoded).toHaveLength(baseline.length);
    const decoder = new GatewayChatEvents(() => {
      throw new Error("Lost warm baseline");
    });
    for (const [index, frame] of encoded.entries()) {
      const legacy = baseline[index]!;
      let decoded: EventFrame | undefined;
      decoder.dispatch(frame, (event) => {
        decoded = event;
      });
      expect(decoded?.payload, `decoded frame ${index}`).toEqual(legacy.payload);
      if (index >= warmCount && (frame.payload as { sessionKey?: string }).sessionKey === key) {
        measurements.push({
          reason:
            (frame.payload as { reason?: string }).reason ??
            (frame.payload as { phase?: string }).phase ??
            frame.event,
          before: Buffer.byteLength(JSON.stringify(legacy)),
          after: Buffer.byteLength(JSON.stringify(frame)),
          full: Object.hasOwn((frame.payload as { session: object }).session, "full"),
        });
      }
    }
  }
  console.log(
    "SESSION_ROW_BASELINE_BYTES",
    JSON.stringify(measurements.slice(0, measurements.length / 2)),
  );
  const retained = await readRetention();
  console.log("SESSION_ROW_BASELINE_RETENTION", JSON.stringify(retained));
  expect(retained.entries).toBe(keys.length * 2);
  expect(resets).toEqual([]);
  expect(measurements.map(({ reason }) => reason)).toEqual(
    expect.arrayContaining([
      "send",
      "agent.run.started",
      "start",
      "session.message",
      "end",
      "agent.input.settled",
      "placement",
      "patch",
      "activity-summary",
    ]),
  );
  expect(measurements.every((entry) => entry.full === false)).toBe(true);
});
