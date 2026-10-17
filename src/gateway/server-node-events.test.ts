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
  enqueueSystemEvent: enqueueSystemEventMock,
  requestHeartbeat: requestHeartbeatMock,
  agentCommandFromIngress: agentCommandMock,
  upsertSessionEntryCore: upsertSessionEntryMock,
  loadSessionEntry: loadSessionEntryMock,
  registerApnsRegistration: registerApnsRegistrationVi,
  normalizeChannelId: normalizeChannelIdVi,
  sendDurableMessageBatch: sendDurableMessageBatchMock,
  loadOrCreateProcessDeviceIdentity: loadOrCreateProcessDeviceIdentityMock,
  parseMessageWithAttachments: parseMessageWithAttachmentsMock,
  persistInboundImagesForTranscript: persistInboundImagesForTranscriptMock,
  updatePairedDevicePresence: updatePairedDevicePresenceMock,
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

beforeEach(() => {
  resetGatewayWorkAdmission();
  enqueueSystemEventMock.mockReset().mockReturnValue(true);
  requestHeartbeatMock.mockClear();
  agentCommandMock.mockClear();
  upsertSessionEntryMock.mockClear();
  loadSessionEntryMock.mockClear();
  loadSessionEntryMock.mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  agentCommandMock.mockResolvedValue({ status: "ok" } as never);
  upsertSessionEntryMock.mockImplementation(async (_scope, patch) => patch);
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

function nodeFixture(nodeId: string, overrides: Partial<NodeEventContext> = {}) {
  const ctx = buildCtx(overrides);
  return {
    ctx,
    emit: (event: string, payload: unknown, connection?: Parameters<typeof handleNodeEvent>[3]) =>
      handleNodeEvent(ctx, nodeId, nodeEvent(event, payload), connection),
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
    registerApnsRegistrationVi.mockClear();
    loadOrCreateProcessDeviceIdentityMock.mockClear();
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
      const finishedEvent = nodeEvent("exec.finished", finishedPayload);
      const unmatchedEvent = eventResult("exec.finished", "unmatched_exec_event");
      const ctx = buildCtx({
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
          handleNodeEvent(ctx, "node-1", finishedEvent, { connId: "wrong-conn" }),
        ).resolves.toEqual(unmatchedEvent);
        await expect(
          handleNodeEvent(ctx, "node-1", nodeEvent("exec.started", startedPayload), connection),
        ).resolves.toBeUndefined();

        const started = [`Exec started (node=node-1 id=${runId}): printf ok`, eventRouting];
        const wake = [execEventHeartbeatOptions(sessionKey)];
        expect(enqueueSystemEventMock.mock.calls).toEqual([started]);
        expect(requestHeartbeatMock.mock.calls).toEqual([wake]);

        await expect(
          handleNodeEvent(ctx, "node-1", finishedEvent, connection),
        ).resolves.toBeUndefined();
        // Remove suppression on replay so filtering cannot hide unconsumed authorization.
        await expect(
          handleNodeEvent(
            ctx,
            "node-1",
            nodeEvent("exec.finished", { ...finishedPayload, suppressNotifyOnExit: false }),
            connection,
          ),
        ).resolves.toEqual(unmatchedEvent);
        const finished = [`Exec finished (node=node-1 id=${runId}, code 0)\ndone`, eventRouting];
        expect(enqueueSystemEventMock.mock.calls).toEqual(
          suppressNotifyOnExit ? [started] : [started, finished],
        );
        expect(requestHeartbeatMock.mock.calls).toEqual(
          suppressNotifyOnExit ? [wake] : [wake, wake],
        );
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
        expect(registerApnsRegistrationVi).toHaveBeenCalledWith({
          nodeId: "node-relay-sandbox",
          ...relayRegistration,
          expectedPairingGeneration: "generation-node-relay-sandbox",
        });
      } else {
        expect(loadOrCreateProcessDeviceIdentityMock).toHaveBeenCalledOnce();
        expect(registerApnsRegistrationVi).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "rejects invalidated APNs ownership (in transaction: %s)",
    async (inTransaction) => {
      const warn = vi.fn();
      if (inTransaction) {
        registerApnsRegistrationVi.mockRejectedValueOnce(new ApnsRegistrationPairingChangedError());
      }
      const result = await handleNodeEvent(
        { ...buildCtx(), logGateway: { warn } },
        "node-register",
        nodeEvent("push.apns.register", directRegistration),
        { resolveApnsRegistrationGeneration: async () => (inTransaction ? "generation" : null) },
      );
      expect(result).toEqual(eventResult("push.apns.register", "pairing_changed"));
      if (!inTransaction) {
        expect(registerApnsRegistrationVi).not.toHaveBeenCalled();
      }
      expect(warn).toHaveBeenCalledWith(
        "push apns register rejected node=node-register: stale or invalidated pairing session",
      );
    },
  );
  it("accepts legacy exec.finished events when authorization matches without runId", async () => {
    const authorizeNodeSystemRunEvent = vi.fn(() => true);
    const { emit } = nodeFixture("node-2", { authorizeNodeSystemRunEvent });
    await emit(
      "exec.finished",
      { sessionKey: "agent:main:main", exitCode: 0, timedOut: false, output: "done" },
      { connId: "conn-1" },
    );

    expect(authorizeNodeSystemRunEvent).toHaveBeenCalledWith({
      nodeId: "node-2",
      connId: "conn-1",
      sessionKey: "agent:main:main",
      event: "exec.finished",
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2, code 0)\ndone",
      { sessionKey: "agent:main:main", contextKey: "exec" },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(execEventHeartbeatOptions("agent:main:main"));
  });

  it("dedupes duplicate exec.finished events for the same runId on the same session", async () => {
    const { emit } = nodeFixture("node-2", { authorizeNodeSystemRunEvent: () => true });
    const payload = {
      sessionKey: "agent:main:main",
      runId: "run-dup-finished",
      exitCode: 0,
      timedOut: false,
      output: "done",
    };

    await emit("exec.finished", payload);
    await emit("exec.finished", payload);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-dup-finished, code 0)\ndone",
      { sessionKey: "agent:main:main", contextKey: "exec:run-dup-finished" },
    );
  });

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
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    },
  );
});

describe("voice transcript events", () => {
  it("persists only the accepted replay session ID when identical new-session events race", async () => {
    const addChatRun = vi.fn();
    const { emit } = nodeFixture("node-new-session-replay", { addChatRun });
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    }));
    let persistedEntry: { sessionId?: string } | undefined;
    upsertSessionEntryMock.mockImplementation(async (_scope, patch) => {
      persistedEntry = patch;
      return patch;
    });
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
    await waitForFast(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));

    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    const dispatched = agentCommandMock.mock.calls[0]?.[0] as { sessionId?: unknown };
    expect(persistedEntry?.sessionId).toBe(dispatched.sessionId);
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

    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(addChatRun).not.toHaveBeenCalled();
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
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

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it.each([
    { event: "voice.transcript", payload: { text: "do not create this" } },
    { event: "agent.request", payload: { message: "do not create this" } },
    { event: "notifications.changed", payload: { change: "posted", key: "notif" } },
  ])(
    "rejects a missing harness-owned session before $event side effects",
    async ({ event, payload }) => {
      const sessionKey = "agent:main:harness:codex:supervision:missing-voice";
      loadSessionEntryMock.mockReturnValueOnce({
        ...buildSessionLookup(sessionKey),
        entry: undefined,
      });
      const addChatRun = vi.fn();
      const { emit } = nodeFixture("node-harness-voice-missing", { addChatRun });

      await emit(event, { ...payload, sessionKey });
      await Promise.resolve();

      expect(upsertSessionEntryMock).not.toHaveBeenCalled();
      expect(addChatRun).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    },
  );

  it("does not block agent dispatch when session-store touch fails", async () => {
    const warn = vi.fn();
    const { emit } = nodeFixture("node-v3", { logGateway: { warn } });
    upsertSessionEntryMock.mockRejectedValueOnce(new Error("disk down"));

    await emit("voice.transcript", {
      text: "continue anyway",
      sessionKey: "voice-store-fail-session",
    });
    await Promise.resolve();

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
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
    const request = handleNodeEvent(
      buildCtx(),
      "node-revoked-during-lookup",
      nodeEvent("notifications.changed", {
        change: "posted",
        key: "notif-revoked",
        sessionKey: "agent:main:notice",
      }),
      { isConnectionCurrent: async () => connectionCurrent },
    );
    await lookupStarted.promise;
    connectionCurrent = false;
    lookup.resolve(buildSessionLookup("agent:main:notice"));

    await expect(request).resolves.toEqual(eventResult("notifications.changed", "pairing_changed"));
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("records non-delivery when a targetless notification has no system owner", async () => {
    const warn = vi.fn();
    runtimeMocks.resolveSystemMainSessionTarget.mockImplementationOnce(() => {
      throw new Error("Set agents.defaults.systemAgent.agentId");
    });

    await handleNodeEvent(
      { ...buildCtx(), logGateway: { warn } },
      "node-unowned",
      nodeEvent("notifications.changed", { change: "posted", key: "notif-unowned" }),
    );

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "notification event not delivered node=node-unowned: Set agents.defaults.systemAgent.agentId",
    );
  });

  it("does not wake heartbeat when notifications.changed event is deduped", async () => {
    enqueueSystemEventMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const ctx = buildCtx();
    const event = nodeEvent("notifications.changed", {
      change: "posted",
      key: "notif-dupe",
      packageName: "com.example.chat",
      title: "Message",
      text: "Ping from Alex",
    });
    await handleNodeEvent(ctx, "node-n6", event);
    await handleNodeEvent(ctx, "node-n6", event);

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      change: "removed",
      nodeId: "node-n2",
      key: "notif-2",
      packageName: "com.example.mail",
      requestedKey: undefined,
      sessionKey: "agent:ops:main",
      agentId: "ops",
      summary: "Notification removed (node=node-n2 key=notif-2 package=com.example.mail)",
    },
    {
      change: "posted",
      nodeId: "node-n5",
      key: "notif-5",
      packageName: undefined,
      requestedKey: "node-node-n5",
      sessionKey: "agent:main:node-node-n5",
      agentId: "main",
      summary: "Notification posted (node=node-n5 key=notif-5)",
    },
  ])(
    "routes $change notifications to $sessionKey",
    async ({ change, nodeId, key, packageName, requestedKey, sessionKey, agentId, summary }) => {
      if (requestedKey) {
        loadSessionEntryMock.mockReturnValueOnce({
          ...buildSessionLookup(requestedKey),
          canonicalKey: sessionKey,
        });
      }
      const ctx = buildCtx();
      await handleNodeEvent(
        ctx,
        nodeId,
        nodeEvent("notifications.changed", { change, key, packageName, sessionKey: requestedKey }),
      );

      const routing = { sessionKey, contextKey: `notification:${key}` };
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        summary,
        requestedKey ? routing : expect.objectContaining(routing),
      );
      expect(requestHeartbeatMock).toHaveBeenCalledWith({
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

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });
});

describe("agent request events", () => {
  beforeEach(() => {
    parseMessageWithAttachmentsMock.mockReset();
    persistInboundImagesForTranscriptMock.mockReset();
    persistInboundImagesForTranscriptMock.mockResolvedValue({ entries: [], omission: "none" });
    runtimeMocks.deleteMediaBuffer.mockClear();
    normalizeChannelIdVi.mockClear();
    normalizeChannelIdVi.mockImplementation((channel?: string | null) => channel ?? null);
    sendDurableMessageBatchMock.mockReset();
    sendDurableMessageBatchMock.mockResolvedValue(sentDurableMessageBatchResult);
    parseMessageWithAttachmentsMock.mockResolvedValue({
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
      loadSessionEntryMock.mockReturnValueOnce(buildSessionLookup(sessionKey, entry));

      await handleNodeEvent(
        buildCtx(),
        "node-harness-request-invalid",
        nodeEvent("agent.request", {
          message: "do not dispatch this",
          sessionKey,
          attachments: [{ type: "image", mimeType: "image/png", content: "aGVsbG8=" }],
        }),
      );

      expect(runtimeMocks.resolveGatewayModelSupportsImages).not.toHaveBeenCalled();
      expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
      expect(upsertSessionEntryMock).not.toHaveBeenCalled();
      expect(persistInboundImagesForTranscriptMock).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each(["voice touch", "agent dispatch", "receipt delivery"] as const)(
    "keeps accepted detached %s visible to suspension",
    async (phase) => {
      const dispatch = createDeferred<never>();
      const receipt = createDeferred<DurableMessageBatchSendResult>();
      const touch = createDeferred();
      if (phase === "voice touch") {
        upsertSessionEntryMock.mockImplementationOnce(() => touch.promise);
      } else if (phase === "agent dispatch") {
        agentCommandMock.mockImplementationOnce(() => dispatch.promise);
      } else {
        sendDurableMessageBatchMock.mockImplementationOnce(() => receipt.promise);
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
        dispatch.resolve(undefined as never);
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
    const { ctx, emit } = nodeFixture("node-revoked-during-model-lookup");
    ctx.loadGatewayModelCatalog = vi.fn(() => modelCatalog.promise);
    let connectionCurrent = true;
    const isConnectionCurrent = vi.fn(async () => connectionCurrent);

    const request = emit(
      "agent.request",
      {
        message: "describe this image",
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

    await expect(request).resolves.toEqual(eventResult("agent.request", "pairing_changed"));
    expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(sendDurableMessageBatchMock).not.toHaveBeenCalled();
    expect(persistInboundImagesForTranscriptMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("cleans persisted transcript media when detached agent admission is revoked", async () => {
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
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

    await handleNodeEvent(
      buildCtx(),
      "node-revoked-before-detached-start",
      nodeEvent("agent.request", {
        message: "do not retain this media",
        sessionKey: "agent:main:revoked-before-detached-start",
      }),
      { isConnectionCurrent },
    );

    await waitForFast(() => {
      expect(runtimeMocks.deleteMediaBuffer).toHaveBeenCalledWith("saved-after-admission");
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "delivers only through the current session route (available: %s)",
    async (available) => {
      const warn = vi.fn();
      if (available) {
        loadSessionEntryMock.mockReturnValueOnce(
          buildSessionLookup("agent:main:main", {
            sessionId: "sid-current",
            lastChannel: "telegram",
            lastTo: "123",
          }),
        );
      }
      await handleNodeEvent(
        { ...buildCtx(), logGateway: { warn } },
        "node-route",
        nodeEvent("agent.request", {
          message: "summarize this",
          sessionKey: "agent:main:main",
          deliver: true,
        }),
      );
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      const opts: unknown = agentCommandMock.mock.calls[0]?.[0];
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
    parseMessageWithAttachmentsMock.mockResolvedValueOnce({
      message: "describe",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 0 }],
      imageOrder: ["inline"],
      offloadedRefs: [],
    });
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
      entries: [],
      omission: "inline-image-save-failed",
    });

    await handleNodeEvent(
      buildCtx(),
      "node-media-omission",
      nodeEvent("agent.request", {
        message: "describe",
        sessionKey: "agent:main:main",
        attachments: [{ type: "image", mimeType: "image/jpeg", content: "AAAA" }],
      }),
    );

    expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
      message: "describe",
      transcriptMessage:
        "describe\n[image attachment omitted: durable managed media claim unavailable]",
    });
  });

  it("declines non-image attachments cleanly when parse throws UnsupportedAttachmentError", async () => {
    const warn = vi.fn();
    const { emit } = nodeFixture("node-non-image-refusal", { logGateway: { warn } });

    parseMessageWithAttachmentsMock.mockRejectedValueOnce(
      Object.assign(new Error("attachment a.pdf: non-image attachments not supported"), {
        name: "UnsupportedAttachmentError",
        reason: "unsupported-non-image",
      }),
    );

    await emit("agent.request", {
      message: "read this",
      sessionKey: "agent:main:main",
      attachments: [
        { type: "file", mimeType: "application/pdf", fileName: "a.pdf", content: "JVBERi0=" },
      ],
    });

    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "agent.request attachment parse failed: attachment a.pdf: non-image attachments not supported",
    );
  });

  beforeEach(() => {
    updatePairedDevicePresenceMock.mockClear();
    updatePairedDevicePresenceMock.mockResolvedValue(true);
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
    expect(updatePairedDevicePresenceMock).not.toHaveBeenCalled();
  });
  it("does not throttle stale node presence alive generations", async () => {
    updatePairedDevicePresenceMock.mockResolvedValue(false);
    const { emit } = nodeFixture("ios-presence-unpaired");
    const result = await emit(
      "node.presence.alive",
      { trigger: "silent_push" },
      presenceConnection("ios-presence-unpaired"),
    );

    expect(result).toEqual(eventResult("node.presence.alive", "pairing_changed"));

    updatePairedDevicePresenceMock.mockClear();
    updatePairedDevicePresenceMock.mockResolvedValue(true);
    const retry = await emit(
      "node.presence.alive",
      { trigger: "silent_push" },
      presenceConnection("ios-presence-unpaired"),
    );
    expect(retry).toEqual(eventResult("node.presence.alive", "persisted", true));
    expect(updatePairedDevicePresenceMock).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated node presence alive persistence per device", async () => {
    const ctx = buildCtx();
    const event = {
      event: "node.presence.alive" as const,
      payloadJSON: JSON.stringify({ trigger: "silent_push" }),
    };
    const connection = presenceConnection("ios-presence-throttle");

    await handleNodeEvent(ctx, "ios-presence-throttle", event, connection);
    const result = await handleNodeEvent(ctx, "ios-presence-throttle", event, connection);

    expect(result).toEqual(eventResult("node.presence.alive", "throttled", true));
    expect(updatePairedDevicePresenceMock).toHaveBeenCalledTimes(1);
  });

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
      const stats = current
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
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
        expect(updatePairedDevicePresenceMock).not.toHaveBeenCalled();
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
      expect(updateNodeHostStats).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
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
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
