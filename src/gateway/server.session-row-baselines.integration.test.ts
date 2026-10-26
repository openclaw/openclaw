import { assert, expect, onTestFinished, test, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { observeSessionEventRowRetention } from "./session-event-row-retention.test-support.js";
import { collectSessionRowFrames } from "./session-row-delta-sockets.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";
import { dispatchInboundMessageMock, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

let harness: Awaited<ReturnType<typeof startGatewayServerHarness>>;
let kernel: Awaited<ReturnType<typeof captureGatewayKernel>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    kernel = await captureGatewayKernel(async () => {
      harness = await startGatewayServerHarness();
    });
    await waitForGatewayStartup(harness.port);
  },
  cleanup: async () => harness?.close(),
});

test("ordinary fact changes keep warm wire rows across three real sockets", async () => {
  const onReset = vi.fn();
  const readRetention = observeSessionEventRowRetention(onReset);
  const sockets = await Promise.all(
    [true, true, false].map((deltas) =>
      harness.openClient({
        caps: ["session-scoped-events", ...(deltas ? ["session-row-deltas"] : [])],
      }),
    ),
  );
  const request = async (socket: (typeof sockets)[number], method: string, params: unknown) => {
    const response = await rpcReq(socket.ws, method, params);
    expect(response.ok).toBe(true);
  };
  const keys = ["parent", "child", "other"].map((suffix) => `agent:main:baseline-${suffix}`);
  const key = keys[1]!;
  const target = { sessionKey: key, agentId: "main" };
  const context = kernel.gatewayRequestContext;
  const projection = getSessionRowProjection(context);
  assert(projection, "Expected runtime session projection");
  const drain = async () => {
    await flushPendingSessionsChangedEvents(context);
    await drainSessionEventPublications(projection);
    for (const socket of sockets) {
      await request(socket, "sessions.list", { agentId: "main", rowMode: "sidebar" });
    }
  };
  for (const [index, sessionKey] of keys.entries()) {
    await request(sockets[0]!, "sessions.create", {
      key: sessionKey,
      agentId: "main",
      visibility: "shared",
      ...(index === 1 ? { parentSessionKey: keys[0], spawnDepth: 1 } : {}),
    });
  }
  await drain();
  for (const socket of sockets) {
    await request(socket, "sessions.subscribe", {});
    await request(socket, "sessions.messages.subscribe", { key });
  }
  const streams = sockets.map(({ ws }) => collectSessionRowFrames(ws));
  const waitForFrame = async (matches: (frame: EventFrame) => boolean) =>
    vi.waitFor(() => expect(streams[2]!.some(matches)).toBe(true));
  const recap = async (sessionKey: string) => {
    const loaded = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, { agentId: "main" });
    await broadcastSessionActivitySummary(
      { key: sessionKey, agentId: "main", storePath: loaded.storePath },
      { getSessionRowProjection: () => projection, broadcast: context.broadcast },
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
  const lifecycle = async (phase: "start" | "end") => {
    emitAgentEvent({
      runId,
      ...target,
      stream: "lifecycle",
      data: {
        phase,
        [phase === "start" ? "startedAt" : "endedAt"]: Date.now(),
      },
    });
    await waitForFrame(
      (frame) =>
        frame.event === "sessions.changed" && (frame.payload as { phase?: string }).phase === phase,
    );
    await drain();
  };
  const completed = createDeferred();
  dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
    const { dispatcher, replyOptions } = args as Parameters<typeof dispatchInboundMessage>[0];
    try {
      await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      await drain();
      await replyOptions?.onAgentRunStart?.(runId);
      await drain();
      await lifecycle("start");
      const queuedFinal = dispatcher.sendFinalReply({ text: "Synthetic baseline reply." });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      await lifecycle("end");
      return { queuedFinal, counts: dispatcher.getQueuedCounts() };
    } finally {
      completed.resolve();
    }
  });
  await request(sockets[0]!, "chat.send", {
    sessionKey: key,
    message: "Synthetic baseline turn.",
    idempotencyKey: runId,
  });
  await completed.promise;
  await waitForFrame(
    (frame) => (frame.payload as { reason?: string }).reason === "agent.input.settled",
  );
  await drain();

  const loaded = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
  assert(loaded.entry, "Expected durable session");
  const placement = kernel.workerEnvironmentStartup?.placementStore;
  assert(placement, "Expected placement owner");
  await placement.startDispatch({ ...target, sessionId: loaded.entry.sessionId });
  emitSessionsChanged(
    context,
    { ...target, reason: "placement" },
    { accessChanged: false, rowScope: "runtime" },
  );
  await drain();
  const patch = async (changes: (entry: SessionEntry) => Partial<SessionEntry>) => {
    const current = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
    assert(current.entry, "Expected durable session");
    const replacement = { ...current.entry, ...changes(current.entry) };
    replaceSessionEntrySync({ ...target, storePath: current.storePath }, replacement);
  };
  await patch(() => ({ modelOverride: "synthetic-model", providerOverride: "synthetic" }));
  emitSessionsChanged(context, { ...target, reason: "patch" });
  await drain();
  await patch((entry) => ({
    activitySummary: {
      version: 1,
      formatRevision: 3,
      text: "Synthetic recap after ordinary facts changed.",
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
  }));
  await recap(key);
  await drain();

  // A sessionless run uses the real registry's broad agent-runs facts notification.
  registerAgentRunContext("baseline-sessionless", { agentId: "main" });
  onTestFinished(() => clearAgentRunContext("baseline-sessionless"));
  await drain();
  await recap(key);
  await drain();
  // A deletion of another session reaches the projection's ancestor invalidation hook.
  await request(sockets[0]!, "sessions.delete", { key: keys[2] });
  await drain();
  await recap(key);
  await drain();

  const baseline = streams[2]!;
  const reasons: string[] = [];
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
      const payload = frame.payload as {
        sessionKey?: string;
        reason?: string;
        phase?: string;
        session: object;
      };
      if (index >= warmCount && payload.sessionKey === key) {
        reasons.push(payload.reason ?? payload.phase ?? frame.event);
        expect(Object.hasOwn(payload.session, "full")).toBe(false);
      }
    }
  }
  expect(await readRetention()).toMatchObject({ entries: keys.length * 2 });
  expect(onReset).not.toHaveBeenCalled();
  expect(reasons).toEqual(
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
});
