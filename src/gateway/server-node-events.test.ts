import "./server-node-events.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.js";
import {
  getCurrentActiveNodeContext,
  setActiveNodeContexts,
} from "../infra/active-node-context.js";
import {
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { ApnsRegistrationPairingChangedError } from "../infra/push-apns-store.errors.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { HealthSummary } from "./health/types.js";
import { NodeRegistry } from "./node-registry.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const { buildSessionLookup, makeNodeClient, runtimeMocks } =
  await import("./server-node-events.test-support.js");
const {
  enqueueSystemEvent: enqueue,
  requestHeartbeat: heartbeat,
  agentCommandFromIngress: dispatch,
  upsertSessionEntryCore: touchSession,
  loadSessionEntry: lookupSession,
  registerApnsRegistration: registerApns,
  normalizeChannelId: normalizeChannel,
  sendDurableMessageBatch: sendBatch,
  loadOrCreateProcessDeviceIdentity: deviceIdentity,
  parseMessageWithAttachments: parseAttachments,
  persistInboundImagesForTranscript: persistImages,
  updatePairedDevicePresence: updatePresence,
} = runtimeMocks;

const sentDurableMessageBatchResult: Extract<DurableMessageBatchSendResult, { status: "sent" }> = {
  status: "sent",
  results: [],
  receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
};

function nodeEvent(event: string, payload: unknown): NodeEvent {
  return { event, payloadJSON: JSON.stringify(payload) };
}

function eventResult(event: string, reason: string, handled = false) {
  return { ok: true, event, handled, reason };
}

function waitForFast<T>(callback: () => T | Promise<T>) {
  return vi.waitFor(callback, { interval: 1 });
}

function expectNoCalls(...mocks: Array<{ mock: { calls: unknown[][] } }>) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  enqueue.mockReset().mockReturnValue(true);
  heartbeat.mockClear();
  dispatch.mockClear();
  touchSession.mockClear();
  lookupSession
    .mockClear()
    .mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  dispatch.mockResolvedValue({ status: "ok" } as never);
  touchSession.mockImplementation(async (_scope, patch) => patch);
});

afterEach(resetGatewayWorkAdmission);

function delayedCurrentness(initialChecks: number, signalAt = initialChecks + 1) {
  const entered = createDeferred();
  const decision = createDeferred<boolean>();
  let checks = 0;
  const check = vi.fn(() => {
    checks += 1;
    if (checks <= initialChecks) {
      return true;
    }
    if (checks === signalAt) {
      entered.resolve();
    }
    return decision.promise;
  });
  return { check, entered: entered.promise, resolve: decision.resolve };
}

const prepareSuspend = (requestId: string) =>
  prepareGatewaySuspend({ requestId, pauseScheduling: vi.fn(), resumeScheduling: vi.fn() });

async function runAdmittedNodeEvent(
  ctx: NodeEventContext,
  nodeId: string,
  event: Parameters<typeof handleNodeEvent>[2],
): Promise<void> {
  const admission = tryBeginGatewayRootWorkAdmission();
  expect(admission).not.toBeNull();
  try {
    await admission?.run(() => handleNodeEvent(ctx, nodeId, event));
  } finally {
    admission?.release();
  }
}

function expectSuspendBusyWithRootWork(requestId: string): void {
  expect(prepareSuspend(requestId)).toMatchObject({
    status: "busy",
    blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request", count: 1 })]),
  });
}

function expectSuspendReady(requestId: string): void {
  const result = prepareSuspend(requestId);
  expect(result).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  if (result.status === "ready") {
    expect(resumeGatewaySuspend(result.suspensionId)).toMatchObject({
      ok: true,
      status: "running",
      resumed: true,
    });
  }
}

const execEventHeartbeatOptions = (sessionKey?: string) => ({
  source: "exec-event",
  intent: "event",
  reason: "exec-event",
  coalesceMs: 0,
  ...(sessionKey ? { sessionKey } : {}),
});

function buildCtx(overrides: Partial<NodeEventContext> = {}): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    authorizeNodeSystemRunEvent: () => false,
    logGateway: { warn: () => {} },
    ...overrides,
  };
}

function nodeFixture(nodeId = "node", overrides: Partial<NodeEventContext> = {}) {
  const ctx = buildCtx(overrides);
  const emit = (
    event: string,
    payload: unknown,
    connection?: Parameters<typeof handleNodeEvent>[3],
  ) => handleNodeEvent(ctx, nodeId, nodeEvent(event, payload), connection);
  return {
    ctx,
    emit,
    request: (
      payload: Record<string, unknown> = {},
      connection?: Parameters<typeof handleNodeEvent>[3],
    ) =>
      emit(
        "agent.request",
        { message: "request", sessionKey: "agent:main:main", ...payload },
        connection,
      ),
    notify: (
      payload: Record<string, unknown> = {},
      connection?: Parameters<typeof handleNodeEvent>[3],
    ) => emit("notifications.changed", { change: "posted", key: "notif", ...payload }, connection),
  };
}

function presenceConnection(deviceId: string, generation = `${deviceId}-generation`) {
  return { deviceId, pairingGeneration: { nodeId: deviceId, key: generation } };
}

const directRegistration = {
  token: "abcd1234abcd1234abcd1234abcd1234",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
};
const relayRegistration = {
  transport: "relay",
  relayHandle: "relay-handle-123",
  sendGrant: "send-grant-123",
  installationId: "install-123",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  distribution: "official",
  tokenDebugSuffix: "abcd1234",
};

describe("node exec events", () => {
  beforeEach(() => {
    registerApns.mockClear();
    deviceIdentity.mockClear();
  });

  it.each([false, true])(
    "preserves exec authorization and terminal consumption with suppressNotifyOnExit=%s",
    async (suppressNotifyOnExit) => {
      const registry = new NodeRegistry();
      const connection = { connId: "conn-1" },
        auth = registry.authorizeSystemRunEvent.bind(registry);
      const [runId, sessionKey] = [`run-seq-suppress-${suppressNotifyOnExit}`, "agent:main:main"];
      const eventRouting = { sessionKey, contextKey: `exec:${runId}` };
      const startedPayload = { runId, sessionKey, command: "printf ok" };
      const finishedPayload = {
        ...startedPayload,
        exitCode: 0,
        timedOut: false,
        output: "done",
        suppressNotifyOnExit,
      };
      const unmatchedEvent = eventResult("exec.finished", "unmatched_exec_event");
      const { emit } = nodeFixture("node-1", {
        authorizeNodeSystemRunEvent: (p) => auth({ ...p, terminal: p.event !== "exec.started" }),
      });
      registry.register(makeNodeClient(connection.connId, "node-1"), {
        pairingIdentity: "identity-a",
      });
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "system.run",
        params: { runId, sessionKey },
        timeoutMs: 0,
      });
      try {
        await expect(
          emit("exec.finished", finishedPayload, { connId: "wrong-conn" }),
        ).resolves.toEqual(unmatchedEvent);
        await expect(emit("exec.started", startedPayload, connection)).resolves.toBeUndefined();

        const started = [`Exec started (node=node-1 id=${runId}): printf ok`, eventRouting];
        const wake = [execEventHeartbeatOptions(sessionKey)];
        expect(enqueue.mock.calls).toEqual([started]);
        expect(heartbeat.mock.calls).toEqual([wake]);

        await expect(emit("exec.finished", finishedPayload, connection)).resolves.toBeUndefined();
        // Remove suppression on replay so filtering cannot hide unconsumed authorization.
        await expect(
          emit("exec.finished", { ...finishedPayload, suppressNotifyOnExit: false }, connection),
        ).resolves.toEqual(unmatchedEvent);
        const finished = [`Exec finished (node=node-1 id=${runId}, code 0)\ndone`, eventRouting];
        expect(enqueue.mock.calls).toEqual(suppressNotifyOnExit ? [started] : [started, finished]);
        expect(heartbeat.mock.calls).toEqual(suppressNotifyOnExit ? [wake] : [wake, wake]);
      } finally {
        registry.unregister(connection.connId);
        await invoke;
      }
    },
  );

  it.each(["gateway-device-1", "gateway-device-other"])(
    "accepts relay APNs registrations only for this gateway: %s",
    async (gatewayDeviceId) => {
      const { emit } = nodeFixture("node-relay-sandbox");
      await emit(
        "push.apns.register",
        { ...relayRegistration, gatewayDeviceId },
        { resolveApnsRegistrationGeneration: () => "generation-node-relay-sandbox" },
      );

      if (gatewayDeviceId === "gateway-device-1") {
        expect(registerApns).toHaveBeenCalledWith({
          nodeId: "node-relay-sandbox",
          ...relayRegistration,
          expectedPairingGeneration: "generation-node-relay-sandbox",
        });
      } else {
        expect(deviceIdentity).toHaveBeenCalledOnce();
        expect(registerApns).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "rejects invalidated APNs ownership (in transaction: %s)",
    async (inTransaction) => {
      const warn = vi.fn();
      if (inTransaction) {
        registerApns.mockRejectedValueOnce(new ApnsRegistrationPairingChangedError());
      }
      const result = await handleNodeEvent(
        { ...buildCtx(), logGateway: { warn } },
        "node-register",
        nodeEvent("push.apns.register", directRegistration),
        { resolveApnsRegistrationGeneration: async () => (inTransaction ? "generation" : null) },
      );
      expect(result).toEqual(eventResult("push.apns.register", "pairing_changed"));
      if (!inTransaction) {
        expect(registerApns).not.toHaveBeenCalled();
      }
      expect(warn).toHaveBeenCalledWith(
        "push apns register rejected node=node-register: stale or invalidated pairing session",
      );
    },
  );
  it.each([undefined, "run-dup-finished"])(
    "authorizes and deduplicates exec.finished (runId: %s)",
    async (runId) => {
      const authorizeNodeSystemRunEvent = vi.fn(() => true);
      const { emit } = nodeFixture("node-2", { authorizeNodeSystemRunEvent });
      const payload = {
        sessionKey: "agent:main:main",
        runId,
        exitCode: 0,
        timedOut: false,
        output: "done",
      };

      await emit("exec.finished", payload, runId ? undefined : { connId: "conn-1" });
      if (runId) {
        await emit("exec.finished", payload);
      } else {
        expect(authorizeNodeSystemRunEvent).toHaveBeenCalledWith({
          nodeId: "node-2",
          connId: "conn-1",
          sessionKey: payload.sessionKey,
          event: "exec.finished",
        });
        expect(heartbeat).toHaveBeenCalledWith(execEventHeartbeatOptions(payload.sessionKey));
      }
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(
        `Exec finished (node=node-2${runId ? ` id=${runId}` : ""}, code 0)\ndone`,
        { sessionKey: payload.sessionKey, contextKey: runId ? `exec:${runId}` : "exec" },
      );
    },
  );

  it.each(["empty output", "disabled notifications"] as const)(
    "suppresses exec completion for %s",
    async (mode) => {
      if (mode === "disabled notifications") {
        const cfg = { session: { mainKey: "main" }, tools: { exec: { notifyOnExit: false } } };
        runtimeMocks.getRuntimeConfig.mockReturnValueOnce(cfg);
      }
      await handleNodeEvent(
        buildCtx({ authorizeNodeSystemRunEvent: () => true }),
        "node-2",
        nodeEvent("exec.finished", {
          runId: mode,
          exitCode: 0,
          timedOut: false,
          output: mode === "empty output" ? "   " : "some output",
        }),
      );
      expectNoCalls(enqueue, heartbeat);
    },
  );
});

describe("voice transcript events", () => {
  it("persists only the accepted replay session ID when identical new-session events race", async () => {
    const addChatRun = vi.fn();
    const { emit } = nodeFixture("node-new-session-replay", { addChatRun });
    lookupSession.mockImplementation((sessionKey: string) => ({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    }));
    const gate = delayedCurrentness(2, 4);
    const isConnectionCurrent = gate.check;
    const payload = {
      text: "one command for a new session",
      eventId: "new-session-replay",
      sessionKey: "voice-new-session-replay-race",
    };

    const firstReplay = emit("voice.transcript", payload, { isConnectionCurrent });
    const duplicateReplay = emit("voice.transcript", payload, { isConnectionCurrent });
    await Promise.all([firstReplay, duplicateReplay]);
    await gate.entered;
    gate.resolve(true);
    await waitForFast(() => expect(dispatch).toHaveBeenCalledTimes(1));

    expect(touchSession).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    const dispatched = dispatch.mock.calls[0]?.[0] as { sessionId?: unknown };
    expect(touchSession.mock.calls[0]?.[1]?.sessionId).toBe(dispatched.sessionId);
  });

  it("rechecks a queued replay after an earlier stale reservation is released", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx({ addChatRun });
    const stale = delayedCurrentness(1);
    let replayCurrent = true;
    const isReplayConnectionCurrent = vi.fn(() => replayCurrent);
    const payload = {
      text: "invalidate while queued",
      sessionKey: "voice-queued-replay-currentness",
    };

    await handleNodeEvent(ctx, "node-stale-queued-voice", nodeEvent("voice.transcript", payload), {
      isConnectionCurrent: stale.check,
    });
    await stale.entered;
    await handleNodeEvent(
      ctx,
      "node-replay-invalidated-while-queued",
      nodeEvent("voice.transcript", payload),
      { isConnectionCurrent: isReplayConnectionCurrent },
    );
    await waitForFast(() => expect(isReplayConnectionCurrent).toHaveBeenCalledTimes(2));

    replayCurrent = false;
    stale.resolve(false);
    await waitForFast(() => expect(isReplayConnectionCurrent).toHaveBeenCalledTimes(3));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expectNoCalls(dispatch, addChatRun, touchSession);
  });

  it("skips the detached session-store touch after voice admission loses ownership", async () => {
    const addChatRun = vi.fn();
    const { emit } = nodeFixture("node-stale-after-voice-admission", { addChatRun });
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      return checkCount <= 3;
    });

    await emit(
      "voice.transcript",
      {
        text: "do not persist stale voice ownership",
        sessionKey: "voice-detached-store-currentness",
      },
      { isConnectionCurrent },
    );
    await waitForFast(() => expect(isConnectionCurrent).toHaveBeenCalledTimes(4));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    expect(touchSession).not.toHaveBeenCalled();
  });

  it.each([
    { event: "voice.transcript", payload: { text: "do not create this" } },
    { event: "agent.request", payload: { message: "do not create this" } },
    { event: "notifications.changed", payload: { change: "posted", key: "notif" } },
  ])(
    "rejects a missing harness-owned session before $event side effects",
    async ({ event, payload }) => {
      const sessionKey = "agent:main:harness:codex:supervision:missing-voice";
      lookupSession.mockReturnValueOnce({
        ...buildSessionLookup(sessionKey),
        entry: undefined,
      });
      const addChatRun = vi.fn();
      const { emit } = nodeFixture("node-harness-voice-missing", { addChatRun });

      await emit(event, { ...payload, sessionKey });
      await Promise.resolve();

      expectNoCalls(touchSession, addChatRun, dispatch, enqueue, heartbeat);
    },
  );

  it("does not block agent dispatch when session-store touch fails", async () => {
    const warn = vi.fn();
    const { emit } = nodeFixture("node-v3", { logGateway: { warn } });
    touchSession.mockRejectedValueOnce(new Error("disk down"));

    await emit("voice.transcript", {
      text: "continue anyway",
      sessionKey: "voice-store-fail-session",
    });
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledTimes(1);
    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("voice session-store update failed");
  });
});

describe("notifications changed events", () => {
  it("does not enqueue a notification when pairing changes during session lookup", async () => {
    const lookupStarted = createDeferred();
    const lookup = createDeferred<ReturnType<typeof buildSessionLookup>>();
    let connectionCurrent = true;
    vi.mocked(loadGatewaySessionEntryReadOnlyInWorker).mockImplementationOnce(async () => {
      lookupStarted.resolve();
      return lookup.promise;
    });
    const { notify } = nodeFixture();
    const request = notify(
      { sessionKey: "agent:main:notice" },
      { isConnectionCurrent: async () => connectionCurrent },
    );
    await lookupStarted.promise;
    connectionCurrent = false;
    lookup.resolve(buildSessionLookup("agent:main:notice"));

    await expect(request).resolves.toEqual(eventResult("notifications.changed", "pairing_changed"));
    expectNoCalls(enqueue, heartbeat);
  });

  it("records non-delivery when a targetless notification has no system owner", async () => {
    const warn = vi.fn();
    runtimeMocks.resolveSystemMainSessionTarget.mockImplementationOnce(() => {
      throw new Error("Set agents.defaults.systemAgent.agentId");
    });

    const { notify } = nodeFixture("node-unowned", { logGateway: { warn } });
    await notify();

    expectNoCalls(enqueue, heartbeat);
    expect(warn).toHaveBeenCalledWith(
      "notification event not delivered node=node-unowned: Set agents.defaults.systemAgent.agentId",
    );
  });

  it("does not wake heartbeat when notifications.changed event is deduped", async () => {
    enqueue.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { notify } = nodeFixture();
    const payload = {
      packageName: "com.example.chat",
      title: "Message",
      text: "Ping from Alex",
    };
    await notify(payload);
    await notify(payload);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["removed", undefined, "agent:ops:main", "ops", "com.example.mail"],
    ["posted", "node-key", "agent:main:node-key", "main", undefined],
  ] as const)(
    "routes %s notifications with session key %s",
    async (change, requestedKey, sessionKey, agentId, packageName) => {
      if (requestedKey) {
        lookupSession.mockReturnValueOnce({
          ...buildSessionLookup(requestedKey),
          canonicalKey: sessionKey,
        });
      }
      const { notify } = nodeFixture();
      await notify({ change, packageName, sessionKey: requestedKey });

      const routing = { sessionKey, contextKey: "notification:notif" };
      expect(enqueue).toHaveBeenCalledWith(
        `Notification ${change} (node=node key=notif${packageName ? ` package=${packageName}` : ""})`,
        requestedKey ? routing : expect.objectContaining(routing),
      );
      expect(heartbeat).toHaveBeenCalledWith({
        source: "notifications-event",
        intent: "event",
        reason: "notifications-event",
        agentId,
        sessionKey,
      });
    },
  );

  it("ignores notifications.changed payloads missing required fields", async () => {
    const { emit } = nodeFixture("node-n3");
    await emit("notifications.changed", { change: "posted" });

    expectNoCalls(enqueue, heartbeat);
  });
});

describe("agent request events", () => {
  beforeEach(() => {
    parseAttachments.mockReset();
    persistImages.mockReset();
    persistImages.mockResolvedValue({ entries: [], omission: "none" });
    runtimeMocks.deleteMediaBuffer.mockClear();
    normalizeChannel.mockClear();
    normalizeChannel.mockImplementation((channel?: string | null) => channel ?? null);
    sendBatch.mockReset();
    sendBatch.mockResolvedValue(sentDurableMessageBatchResult);
    parseAttachments.mockResolvedValue({
      message: "parsed message",
      images: [],
      imageOrder: [],
      offloadedRefs: [],
    });
  });

  it.each([
    ["wrong owner", { agentHarnessId: "other", modelSelectionLocked: true }],
    ["missing session id", { agentHarnessId: "codex", modelSelectionLocked: true, sessionId: "" }],
  ] as const)(
    "rejects a harness-owned agent request with %s before side effects",
    async (_label, entry) => {
      const sessionKey = `agent:main:harness:codex:supervision:invalid-request-${_label.replaceAll(" ", "-")}`;
      lookupSession.mockReturnValueOnce(buildSessionLookup(sessionKey, entry));

      const { request } = nodeFixture("node-harness-request-invalid");
      await request({
        sessionKey,
        attachments: [{ type: "image", mimeType: "image/png", content: "aGVsbG8=" }],
      });

      expectNoCalls(
        runtimeMocks.resolveGatewayModelSupportsImages,
        parseAttachments,
        touchSession,
        persistImages,
        dispatch,
      );
    },
  );

  it.each(["voice touch", "agent dispatch", "receipt delivery"] as const)(
    "keeps accepted detached %s visible to suspension",
    async (phase) => {
      const dispatchGate = createDeferred<never>();
      const receipt = createDeferred<DurableMessageBatchSendResult>();
      const touch = createDeferred();
      if (phase === "voice touch") {
        touchSession.mockImplementationOnce(() => touch.promise);
      } else if (phase === "agent dispatch") {
        dispatch.mockImplementationOnce(() => dispatchGate.promise);
      } else {
        sendBatch.mockImplementationOnce(() => receipt.promise);
      }

      await runAdmittedNodeEvent(
        buildCtx(),
        `node-${phase}-suspend`,
        phase === "voice touch"
          ? nodeEvent("voice.transcript", {
              text: "persist before suspension",
              sessionKey: "voice-suspend-session",
            })
          : nodeEvent("agent.request", {
              message: "finish before suspension",
              sessionKey: "agent:main:suspend-agent",
              ...(phase === "receipt delivery"
                ? { deliver: true, receipt: true, channel: "telegram", to: "123" }
                : {}),
            }),
      );

      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
      expectSuspendBusyWithRootWork(`${phase}-busy`);
      if (phase === "voice touch") {
        touch.resolve();
      } else if (phase === "agent dispatch") {
        dispatchGate.resolve(undefined as never);
      } else {
        receipt.resolve(sentDurableMessageBatchResult);
      }
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expectSuspendReady(`${phase}-ready`);
    },
  );

  it("does not launch agent work when pairing changes during model lookup", async () => {
    const modelCatalog =
      createDeferred<Awaited<ReturnType<NodeEventContext["loadGatewayModelCatalog"]>>>();
    const { ctx, request } = nodeFixture("node-revoked-during-model-lookup");
    ctx.loadGatewayModelCatalog = vi.fn(() => modelCatalog.promise);
    let connectionCurrent = true;
    const isConnectionCurrent = vi.fn(async () => connectionCurrent);

    const pending = request(
      {
        sessionKey: "agent:main:revoked-during-model-lookup",
        attachments: [{ type: "image", mimeType: "image/png", content: "AAAA" }],
        deliver: true,
        receipt: true,
        channel: "telegram",
        to: "123",
      },
      { isConnectionCurrent },
    );

    await waitForFast(() => expect(ctx.loadGatewayModelCatalog).toHaveBeenCalledTimes(1));
    connectionCurrent = false;
    modelCatalog.resolve([]);

    await expect(pending).resolves.toEqual(eventResult("agent.request", "pairing_changed"));
    expectNoCalls(parseAttachments, touchSession, sendBatch, persistImages, dispatch);
  });

  it("cleans persisted transcript media when detached agent admission is revoked", async () => {
    persistImages.mockResolvedValueOnce({
      entries: [
        {
          id: "saved-after-admission",
          path: "/media/inbound/saved-after-admission.png",
          sourceIndex: 0,
          imageKind: "inline",
          fact: { url: "media://inbound/saved-after-admission.png", contentType: "image/png" },
        },
      ],
      omission: "none",
    });
    let currentnessChecks = 0;
    const isConnectionCurrent = vi.fn(async () => {
      currentnessChecks += 1;
      return currentnessChecks < 6;
    });

    const { request } = nodeFixture("node-revoked-before-detached-start");
    await request(
      { sessionKey: "agent:main:revoked-before-detached-start" },
      { isConnectionCurrent },
    );

    await waitForFast(() => {
      expect(runtimeMocks.deleteMediaBuffer).toHaveBeenCalledWith("saved-after-admission");
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "delivers only through the current session route (available: %s)",
    async (available) => {
      const warn = vi.fn();
      if (available) {
        lookupSession.mockReturnValueOnce(
          buildSessionLookup("agent:main:main", {
            sessionId: "sid-current",
            lastChannel: "telegram",
            lastTo: "123",
          }),
        );
      }
      const { request } = nodeFixture("node-route", { logGateway: { warn } });
      await request({ message: "summarize this", deliver: true });
      expect(dispatch).toHaveBeenCalledTimes(1);
      const opts: unknown = dispatch.mock.calls[0]?.[0];
      expect(opts).toMatchObject({
        message: "summarize this",
        sessionKey: "agent:main:main",
        deliver: available,
        channel: available ? "telegram" : undefined,
        to: available ? "123" : undefined,
      });
      if (available) {
        expect(opts).toMatchObject({ runId: "sid-current", sessionId: "sid-current" });
      } else {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain(
          "agent delivery disabled node=node-route",
        );
      }
    },
  );
  it("records a visible durable omission when inline image persistence fails", async () => {
    parseAttachments.mockResolvedValueOnce({
      message: "describe",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 0 }],
      imageOrder: ["inline"],
      offloadedRefs: [],
    });
    persistImages.mockResolvedValueOnce({
      entries: [],
      omission: "inline-image-save-failed",
    });

    const { request } = nodeFixture("node-media-omission");
    await request({
      message: "describe",
      attachments: [{ type: "image", mimeType: "image/jpeg", content: "AAAA" }],
    });

    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      message: "describe",
      transcriptMessage:
        "describe\n[image attachment omitted: durable managed media claim unavailable]",
    });
  });

  it("declines non-image attachments cleanly when parse throws UnsupportedAttachmentError", async () => {
    const warn = vi.fn();
    const { request } = nodeFixture("node-non-image-refusal", { logGateway: { warn } });

    parseAttachments.mockRejectedValueOnce(
      Object.assign(new Error("attachment a.pdf: non-image attachments not supported"), {
        name: "UnsupportedAttachmentError",
        reason: "unsupported-non-image",
      }),
    );

    await request({
      message: "read this",
      attachments: [
        { type: "file", mimeType: "application/pdf", fileName: "a.pdf", content: "JVBERi0=" },
      ],
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "agent.request attachment parse failed: attachment a.pdf: non-image attachments not supported",
    );
  });

  beforeEach(() => {
    updatePresence.mockClear();
    updatePresence.mockResolvedValue(true);
  });

  it.each([
    { connection: undefined, reason: "missing_device_identity" },
    { connection: { deviceId: "ios-presence" }, reason: "pairing_changed" },
  ])("rejects presence without authority: $reason", async ({ connection, reason }) => {
    const result = await handleNodeEvent(
      buildCtx(),
      "ios-presence",
      nodeEvent("node.presence.alive", { trigger: "silent_push" }),
      connection,
    );
    expect(result).toEqual(eventResult("node.presence.alive", reason));
    expect(updatePresence).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "throttles only persisted presence generations (persisted: %s)",
    async (persisted) => {
      const deviceId = `ios-presence-${persisted}`;
      const { emit } = nodeFixture(deviceId);
      const connection = presenceConnection(deviceId);
      updatePresence.mockResolvedValueOnce(persisted);
      expect(await emit("node.presence.alive", { trigger: "silent_push" }, connection)).toEqual(
        eventResult("node.presence.alive", persisted ? "persisted" : "pairing_changed", persisted),
      );
      expect(updatePresence).toHaveBeenCalledTimes(1);
      updatePresence.mockClear();
      const retry = await emit("node.presence.alive", { trigger: "silent_push" }, connection);
      expect(retry).toEqual(
        eventResult("node.presence.alive", persisted ? "throttled" : "persisted", true),
      );
      expect(updatePresence).toHaveBeenCalledTimes(persisted ? 0 : 1);
    },
  );

  it.each(["current", "stale", "invalidated"] as const)(
    "handles host stats from a %s connection without changing activity or the live snapshot",
    async (connection) => {
      const registry = new NodeRegistry();
      const client = makeNodeClient("stats-connection", "stats-node");
      const session = registry.register(client, { pairingIdentity: "stats-identity" });
      const broadcast = vi.fn();
      const { emit } = nodeFixture(session.nodeId, {
        broadcast,
        updateNodeHostStats: (params) => registry.updateHostStats(params),
      });
      const current = connection === "current";
      const stats: Parameters<typeof registry.updateHostStats>[0]["stats"] = current
        ? {
            cpuCount: 8,
            loadAverage: [1.5, 1, 0.5],
            memoryTotalBytes: 8192,
            memoryFreeBytes: 4096,
            diskTotalBytes: 32768,
            diskAvailableBytes: 16384,
          }
        : { cpuCount: 4, memoryTotalBytes: 8192, memoryFreeBytes: 4096 };
      if (!current) {
        registry.updateHostStats({
          nodeId: session.nodeId,
          connId: client.connId,
          stats,
          observedAtMs: 100,
        });
      }
      if (connection === "invalidated") {
        registry.invalidateConnectionForPairingChange(client.connId);
      }
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
      setActiveNodeContexts([{ nodeId: "active-computer" }]);
      try {
        await expect(
          emit("node.host.stats", current ? stats : { ...stats, memoryFreeBytes: 1024 }, {
            connId: connection === "stale" ? "retired-connection" : client.connId,
            presenceAllowed: false,
          }),
        ).resolves.toEqual(
          eventResult("node.host.stats", current ? "updated" : "stale_connection", current),
        );
        expect(session.hostStats).toEqual({ ...stats, updatedAtMs: current ? 100_000 : 100 });
        if (current) {
          expect(broadcast).toHaveBeenCalledExactlyOnceWith(
            "node.hostStats",
            { nodeId: session.nodeId, hostStats: { ...stats, updatedAtMs: 100_000 } },
            { dropIfSlow: true },
          );
        } else {
          expect(broadcast).not.toHaveBeenCalled();
        }
        expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "active-computer" });
        expectNoCalls(enqueue, updatePresence);
      } finally {
        nowSpy.mockRestore();
        setActiveNodeContexts([]);
        registry.unregister(client.connId);
      }
    },
  );

  it.each(["not json", '{"cpuCount":4}'])(
    "rejects malformed host stats: %s",
    async (payloadJSON) => {
      const updateNodeHostStats = vi.fn();
      const broadcast = vi.fn();
      await expect(
        handleNodeEvent(
          { ...buildCtx(), updateNodeHostStats, broadcast },
          "stats-node",
          { event: "node.host.stats", payloadJSON },
          { connId: "stats-connection" },
        ),
      ).resolves.toEqual(eventResult("node.host.stats", "invalid_payload"));
      expectNoCalls(updateNodeHostStats, broadcast);
    },
  );

  it.each([
    ["updated", { idleSeconds: 10 }, true],
    ["permission_required", { idleSeconds: 0 }, false],
    ["cleared", { action: "clear" }, false],
  ] as const)(
    "handles authenticated node activity: %s",
    async (reason, payload, presenceAllowed) => {
      const activity = { lastActiveAtMs: 90_000, presenceUpdatedAtMs: 100_000 };
      const broadcast = vi.fn();
      const updateNodePresenceActivity = vi.fn(() => activity);
      const clearNodePresenceActivity = vi.fn(() => true);
      const { emit } = nodeFixture("mac-node", {
        broadcast,
        updateNodePresenceActivity,
        clearNodePresenceActivity,
      });
      const allowed = reason !== "permission_required";
      expect(
        await emit("node.presence.activity", payload, {
          connId: "conn-1",
          deviceId: "mac-node",
          presenceAllowed,
        }),
      ).toEqual(eventResult("node.presence.activity", reason, allowed));
      const identity = { nodeId: "mac-node", connId: "conn-1" };
      expect(updateNodePresenceActivity.mock.calls).toEqual(
        reason === "updated" ? [[{ ...identity, idleSeconds: 10 }]] : [],
      );
      expect(clearNodePresenceActivity.mock.calls).toEqual(
        reason === "cleared" ? [[identity]] : [],
      );
      const timestamps =
        reason === "updated" ? activity : { lastActiveAtMs: null, presenceUpdatedAtMs: null };
      const notification = [
        "node.presence",
        { nodeId: "mac-node", ...timestamps },
        { dropIfSlow: true },
      ];
      expect(broadcast.mock.calls).toEqual(allowed ? [notification] : []);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});

describe("chat subscribe/unsubscribe events", () => {
  it.each(["chat.subscribe", "chat.unsubscribe"] as const)(
    "canonicalizes %s with its connection owner",
    async (event) => {
      const callback = vi.fn();
      const ctx = {
        ...buildCtx(),
        [event === "chat.subscribe" ? "nodeSubscribe" : "nodeUnsubscribe"]: callback,
      };
      await handleNodeEvent(ctx, "node-c1", nodeEvent(event, { sessionKey: "  Main  " }), {
        connId: "node-c1-connection",
      });
      expect(callback).toHaveBeenCalledWith("node-c1", "agent:main:main", "node-c1-connection");
    },
  );
  it("skips the event when the payload is missing a session key", async () => {
    const nodeSubscribe = vi.fn();
    const ctx = { ...buildCtx(), nodeSubscribe };

    await handleNodeEvent(ctx, "node-c3", nodeEvent("chat.subscribe", { other: 1 }));

    expect(nodeSubscribe).not.toHaveBeenCalled();
  });
});
