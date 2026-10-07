import "./server-node-events.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getCurrentActiveNodeContext,
  setActiveNodeContexts,
} from "../infra/active-node-context.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { NodeRegistry } from "./node-registry.js";
import type { NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const {
  buildSessionLookup,
  buildCtx,
  nodeEvent,
  eventResult,
  waitForFast,
  runAdmittedNodeEvent,
  expectSuspendBusyWithRootWork,
  expectSuspendReady,
  resetNodeEventTestState,
  makeNodeClient,
  loadOrCreateProcessDeviceIdentityMock,
  runtimeMocks,
  updatePairedDevicePresenceMock,
} = await import("./server-node-events.test-support.js");

const enqueueSessionEventMock = runtimeMocks.enqueueSessionEvent;
const enqueueSystemEventEntryMock = runtimeMocks.enqueueSystemEventEntry;
const agentCommandMock = runtimeMocks.agentCommandFromIngress;
const upsertSessionEntryMock = runtimeMocks.upsertSessionEntryCore;
const loadSessionEntryMock = runtimeMocks.loadSessionEntry;
const resolveSessionTargetMock = runtimeMocks.resolveGatewaySessionStoreTargetInWorker;
const registerApnsRegistrationVi = runtimeMocks.registerApnsRegistration;

beforeEach(resetNodeEventTestState);

afterEach(resetGatewayWorkAdmission);

function presenceConnection(deviceId: string, generation = `${deviceId}-generation`) {
  return {
    deviceId,
    pairingGeneration: { nodeId: deviceId, key: generation },
  };
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

  it.each(["exec.finished", "notifications.changed"])(
    "rejects a replaced connection while %s prepares its session target",
    async (event) => {
      const captureStarted = createDeferred();
      const capturedTarget = createDeferred<{ agentId: string; sessionKey: string }>();
      runtimeMocks.captureSessionEventTarget.mockImplementationOnce(async () => {
        captureStarted.resolve();
        return await capturedTarget.promise;
      });
      const authorizeNodeSystemRunEvent = vi.fn(() => true);
      let current = true;
      const handling = handleNodeEvent(
        buildCtx({ authorizeNodeSystemRunEvent }),
        "node-replaced",
        nodeEvent(event, {
          sessionKey: "agent:main:main",
          runId: "replaced-connection",
          exitCode: 0,
          output: "finished",
          change: "posted",
          key: "replaced-notification",
        }),
        { isConnectionCurrent: async () => current },
      );
      await captureStarted.promise;
      current = false;
      capturedTarget.resolve({ agentId: "main", sessionKey: "agent:main:main" });

      await expect(handling).resolves.toEqual(eventResult(event, "pairing_changed"));
      expect(authorizeNodeSystemRunEvent).not.toHaveBeenCalled();
      expect(loadSessionEntryMock).not.toHaveBeenCalled();
      expect(enqueueSystemEventEntryMock).not.toHaveBeenCalled();
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves exec authorization and terminal consumption with suppressNotifyOnExit=%s",
    async (suppressNotifyOnExit) => {
      const registry = new NodeRegistry();
      const connection = { connId: "conn-1" };
      const runId = `run-seq-suppress-${suppressNotifyOnExit}`;
      const sessionKey = "agent:main:main";
      const eventRouting = {
        agentId: "main",
        sessionKey,
        source: "node",
        contextKey: `exec:${runId}`,
        expectedTarget: { agentId: "main", sessionKey },
      };
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
        authorizeNodeSystemRunEvent: (params) => registry.authorizeSystemRunEvent(params),
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
        expect(enqueueSessionEventMock.mock.calls).toEqual([started]);

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
        expect(enqueueSessionEventMock.mock.calls).toEqual(
          suppressNotifyOnExit ? [started] : [started, finished],
        );
      } finally {
        registry.unregister(connection.connId);
        await invoke;
      }
    },
  );

  it("stores sandbox relay APNs registrations from node events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-relay-sandbox",
      nodeEvent("push.apns.register", {
        ...relayRegistration,
        gatewayDeviceId: "gateway-device-1",
      }),
      { resolveApnsRegistrationGeneration: () => "generation-node-relay-sandbox" },
    );

    expect(registerApnsRegistrationVi).toHaveBeenCalledWith({
      nodeId: "node-relay-sandbox",
      ...relayRegistration,
      expectedPairingGeneration: "generation-node-relay-sandbox",
    });
  });

  it("rejects relay registrations bound to a different gateway identity", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-relay",
      nodeEvent("push.apns.register", {
        ...relayRegistration,
        gatewayDeviceId: "gateway-device-other",
      }),
      { resolveApnsRegistrationGeneration: () => "generation-node-relay" },
    );

    expect(loadOrCreateProcessDeviceIdentityMock).toHaveBeenCalledOnce();
    expect(registerApnsRegistrationVi).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects invalidated APNs ownership (in transaction: %s)",
    async (inTransaction) => {
      const warn = vi.fn();
      if (inTransaction) {
        registerApnsRegistrationVi.mockRejectedValueOnce(
          new runtimeMocks.ApnsRegistrationPairingChangedError(),
        );
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
    const ctx = buildCtx({ authorizeNodeSystemRunEvent });
    await handleNodeEvent(
      ctx,
      "node-2",
      nodeEvent("exec.finished", {
        sessionKey: "agent:main:main",
        exitCode: 0,
        timedOut: false,
        output: "done",
      }),
      { connId: "conn-1" },
    );

    expect(authorizeNodeSystemRunEvent).toHaveBeenCalledWith({
      nodeId: "node-2",
      connId: "conn-1",
      sessionKey: "agent:main:main",
      terminal: true,
    });
    expect(enqueueSessionEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2, code 0)\ndone",
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:main",
        source: "node",
        contextKey: "exec",
      }),
    );
  });

  it("dedupes duplicate exec.finished events for the same runId on the same session", async () => {
    const ctx = buildCtx({ authorizeNodeSystemRunEvent: () => true });
    const payloadJSON = JSON.stringify({
      sessionKey: "agent:main:main",
      runId: "run-dup-finished",
      exitCode: 0,
      timedOut: false,
      output: "done",
    });

    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON,
    });
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON,
    });

    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueSessionEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-dup-finished, code 0)\ndone",
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:main",
        contextKey: "exec:run-dup-finished",
      }),
    );
  });

  it.each(["empty output", "disabled notifications"] as const)(
    "suppresses exec completion for %s",
    async (mode) => {
      if (mode === "disabled notifications") {
        const cfg = {
          session: { mainKey: "agent:main:main" },
          tools: { exec: { notifyOnExit: false } },
        };
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
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    },
  );
});

describe("voice transcript events", () => {
  it("persists only the accepted replay session ID when identical new-session events race", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    }));
    let persistedEntry: { sessionId?: string } | undefined;
    upsertSessionEntryMock.mockImplementation(async (_scope, patch) => {
      persistedEntry = patch;
      return patch;
    });
    const detachedChecksStarted = createDeferred();
    const detachedAdmission = createDeferred<boolean>();
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      if (checkCount <= 2) {
        return true;
      }
      if (checkCount === 4) {
        detachedChecksStarted.resolve();
      }
      return detachedAdmission.promise;
    });
    const payload = {
      text: "one command for a new session",
      eventId: "new-session-replay",
      sessionKey: "voice-new-session-replay-race",
    };

    const firstReplay = handleNodeEvent(
      ctx,
      "node-new-session-replay",
      nodeEvent("voice.transcript", payload),
      { isConnectionCurrent },
    );
    const duplicateReplay = handleNodeEvent(
      ctx,
      "node-new-session-replay",
      nodeEvent("voice.transcript", payload),
      { isConnectionCurrent },
    );
    await Promise.all([firstReplay, duplicateReplay]);
    await detachedChecksStarted.promise;
    detachedAdmission.resolve(true);
    await waitForFast(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));

    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    const dispatched = agentCommandMock.mock.calls[0]?.[0] as { sessionId?: unknown };
    expect(persistedEntry?.sessionId).toBe(dispatched.sessionId);
  });

  it("rechecks a queued replay after an earlier stale reservation is released", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    const staleCheckStarted = createDeferred();
    const staleAdmission = createDeferred<boolean>();
    let staleCheckCount = 0;
    const isStaleConnectionCurrent = vi.fn(() => {
      staleCheckCount += 1;
      if (staleCheckCount === 1) {
        return true;
      }
      staleCheckStarted.resolve();
      return staleAdmission.promise;
    });
    let replayCurrent = true;
    const isReplayConnectionCurrent = vi.fn(() => replayCurrent);
    const payload = {
      text: "invalidate while queued",
      sessionKey: "voice-queued-replay-currentness",
    };

    await handleNodeEvent(ctx, "node-stale-queued-voice", nodeEvent("voice.transcript", payload), {
      isConnectionCurrent: isStaleConnectionCurrent,
    });
    await staleCheckStarted.promise;
    await handleNodeEvent(
      ctx,
      "node-replay-invalidated-while-queued",
      nodeEvent("voice.transcript", payload),
      { isConnectionCurrent: isReplayConnectionCurrent },
    );
    await waitForFast(() => expect(isReplayConnectionCurrent).toHaveBeenCalledTimes(2));

    replayCurrent = false;
    staleAdmission.resolve(false);
    await waitForFast(() => expect(isReplayConnectionCurrent).toHaveBeenCalledTimes(3));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(addChatRun).not.toHaveBeenCalled();
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("skips the detached session-store touch after voice admission loses ownership", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      return checkCount <= 3;
    });

    await handleNodeEvent(
      ctx,
      "node-stale-after-voice-admission",
      nodeEvent("voice.transcript", {
        text: "do not persist stale voice ownership",
        sessionKey: "voice-detached-store-currentness",
      }),
      { isConnectionCurrent },
    );
    await waitForFast(() => expect(isConnectionCurrent).toHaveBeenCalledTimes(4));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("rejects a missing harness-owned session before touching the store", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-voice";
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    });
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;

    await handleNodeEvent(
      ctx,
      "node-harness-voice-missing",
      nodeEvent("voice.transcript", { text: "do not create this", sessionKey }),
    );
    await Promise.resolve();

    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(addChatRun).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("keeps an accepted detached session-store touch visible to suspension", async () => {
    const touch = createDeferred();
    upsertSessionEntryMock.mockImplementationOnce(() => touch.promise);

    await runAdmittedNodeEvent(
      buildCtx(),
      "node-v-suspend",
      nodeEvent("voice.transcript", {
        text: "persist before suspension",
        sessionKey: "voice-suspend-session",
      }),
    );

    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
    expectSuspendBusyWithRootWork("voice-touch-busy");
    touch.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expectSuspendReady("voice-touch-ready");
  });
  it("does not block agent dispatch when session-store touch fails", async () => {
    const warn = vi.fn();
    const ctx = buildCtx();
    ctx.logGateway = { warn };
    upsertSessionEntryMock.mockRejectedValueOnce(new Error("disk down"));

    await handleNodeEvent(
      ctx,
      "node-v3",
      nodeEvent("voice.transcript", {
        text: "continue anyway",
        sessionKey: "voice-store-fail-session",
      }),
    );
    await Promise.resolve();

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]?.[0])).toContain("voice session-store update failed");
  });
});

describe("notifications changed events", () => {
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

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "notification event not delivered node=node-unowned: Set agents.defaults.systemAgent.agentId",
    );
  });

  it("rejects missing reserved notification contexts before enqueue", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-notification";
    resolveSessionTargetMock.mockResolvedValueOnce({
      ...buildSessionLookup(sessionKey),
      store: {},
    });

    await handleNodeEvent(
      buildCtx(),
      "node-harness-missing",
      nodeEvent("notifications.changed", { change: "posted", key: "notif", sessionKey }),
    );

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("does not admit another turn when notifications.changed is deduped", async () => {
    enqueueSystemEventEntryMock
      .mockReturnValueOnce({ id: "notification", text: "notification" })
      .mockReturnValueOnce(undefined);
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

    expect(enqueueSystemEventEntryMock).toHaveBeenCalledTimes(2);
    expect(enqueueSessionEventMock).toHaveBeenCalledTimes(1);
  });
  it("enqueues notifications.changed removed events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-n2",
      nodeEvent("notifications.changed", {
        change: "removed",
        key: "notif-2",
        packageName: "com.example.mail",
      }),
    );

    expect(enqueueSessionEventMock).toHaveBeenCalledWith(
      "Notification removed (node=node-n2 key=notif-2 package=com.example.mail)",
      expect.objectContaining({
        sessionKey: "agent:ops:main",
        contextKey: "notification:notif-2",
      }),
    );
    expect(enqueueSessionEventMock.mock.calls[0]?.[1]).toMatchObject({
      agentId: "ops",
      source: "device",
      expectedTarget: { agentId: "ops", sessionKey: "agent:ops:main" },
      occurrence: { id: "event" },
    });
  });

  it("canonicalizes notifications session key before enqueue and wake", async () => {
    resolveSessionTargetMock.mockResolvedValueOnce({
      ...buildSessionLookup("node-node-n5"),
      canonicalKey: "agent:main:node-node-n5",
    });
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-n5",
      nodeEvent("notifications.changed", {
        change: "posted",
        key: "notif-5",
        sessionKey: "node-node-n5",
      }),
    );

    expect(resolveSessionTargetMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      key: "node-node-n5",
      agentId: undefined,
    });
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).toHaveBeenCalledWith(
      "Notification posted (node=node-n5 key=notif-5)",
      expect.objectContaining({
        sessionKey: "agent:main:node-node-n5",
        contextKey: "notification:notif-5",
      }),
    );
    expect(enqueueSessionEventMock.mock.calls[0]?.[1]).toMatchObject({
      agentId: "main",
      expectedTarget: { agentId: "main", sessionKey: "agent:main:node-node-n5" },
    });
  });

  it("ignores notifications.changed payloads missing required fields", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-n3",
      nodeEvent("notifications.changed", {
        change: "posted",
      }),
    );

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });
});

describe("node presence and host stats events", () => {
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
    const ctx = buildCtx();
    const result = await handleNodeEvent(
      ctx,
      "ios-presence-unpaired",
      nodeEvent("node.presence.alive", { trigger: "silent_push" }),
      presenceConnection("ios-presence-unpaired"),
    );

    expect(result).toEqual(eventResult("node.presence.alive", "pairing_changed"));

    updatePairedDevicePresenceMock.mockClear();
    updatePairedDevicePresenceMock.mockResolvedValue(true);
    const retry = await handleNodeEvent(
      ctx,
      "ios-presence-unpaired",
      nodeEvent("node.presence.alive", { trigger: "silent_push" }),
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

  it("stores host stats on the current connection without Accessibility or prompt changes", async () => {
    const registry = new NodeRegistry();
    const client = makeNodeClient("stats-connection", "stats-node");
    const session = registry.register(client, { pairingIdentity: "stats-identity" });
    const broadcast = vi.fn();
    const ctx: NodeEventContext = {
      ...buildCtx(),
      broadcast,
      updateNodeHostStats: (params) => registry.updateHostStats(params),
    };
    const stats = {
      cpuCount: 8,
      loadAverage: [1.5, 1, 0.5],
      memoryTotalBytes: 8192,
      memoryFreeBytes: 4096,
      diskTotalBytes: 32768,
      diskAvailableBytes: 16384,
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    setActiveNodeContexts([{ nodeId: "active-computer" }]);
    try {
      await expect(
        handleNodeEvent(ctx, session.nodeId, nodeEvent("node.host.stats", stats), {
          connId: client.connId,
          presenceAllowed: false,
        }),
      ).resolves.toEqual(eventResult("node.host.stats", "updated", true));
      expect(session.hostStats).toEqual({ ...stats, updatedAtMs: 100_000 });
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        "node.hostStats",
        { nodeId: session.nodeId, hostStats: { ...stats, updatedAtMs: 100_000 } },
        { dropIfSlow: true },
      );
      expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "active-computer" });
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      expect(updatePairedDevicePresenceMock).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      setActiveNodeContexts([]);
      registry.unregister(client.connId);
    }
  });

  it.each(["stale", "invalidated"] as const)(
    "rejects host stats from a %s connection without replacing the live snapshot",
    async (connection) => {
      const registry = new NodeRegistry();
      const client = makeNodeClient("stats-connection", "stats-node");
      const session = registry.register(client, { pairingIdentity: "stats-identity" });
      const stats = { cpuCount: 4, memoryTotalBytes: 8192, memoryFreeBytes: 4096 };
      registry.updateHostStats({
        nodeId: session.nodeId,
        connId: client.connId,
        stats,
        observedAtMs: 100,
      });
      if (connection === "invalidated") {
        registry.invalidateConnectionForPairingChange(client.connId);
      }
      const broadcast = vi.fn();
      const ctx: NodeEventContext = {
        ...buildCtx(),
        broadcast,
        updateNodeHostStats: (params) => registry.updateHostStats(params),
      };
      try {
        await expect(
          handleNodeEvent(
            ctx,
            session.nodeId,
            nodeEvent("node.host.stats", { ...stats, memoryFreeBytes: 1024 }),
            {
              connId: connection === "stale" ? "retired-connection" : client.connId,
            },
          ),
        ).resolves.toEqual(eventResult("node.host.stats", "stale_connection"));
        expect(session.hostStats).toEqual({ ...stats, updatedAtMs: 100 });
        expect(broadcast).not.toHaveBeenCalled();
      } finally {
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

  it("updates authenticated accessibility-backed node activity without a system event", async () => {
    const broadcast = vi.fn();
    const updateNodePresenceActivity = vi.fn(() => ({
      lastActiveAtMs: 90_000,
      presenceUpdatedAtMs: 100_000,
    }));
    const ctx: NodeEventContext = {
      ...buildCtx(),
      broadcast,
      updateNodePresenceActivity,
    };
    const result = await handleNodeEvent(
      ctx,
      "mac-node",
      nodeEvent("node.presence.activity", { idleSeconds: 10 }),
      { connId: "conn-1", deviceId: "mac-node", presenceAllowed: true },
    );

    expect(result).toEqual(eventResult("node.presence.activity", "updated", true));
    expect(updateNodePresenceActivity).toHaveBeenCalledWith({
      nodeId: "mac-node",
      connId: "conn-1",
      idleSeconds: 10,
    });
    expect(broadcast).toHaveBeenCalledWith(
      "node.presence",
      {
        nodeId: "mac-node",
        lastActiveAtMs: 90_000,
        presenceUpdatedAtMs: 100_000,
      },
      { dropIfSlow: true },
    );
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });

  it("rejects node activity without the advertised accessibility permission", async () => {
    const updateNodePresenceActivity = vi.fn();
    const ctx: NodeEventContext = { ...buildCtx(), updateNodePresenceActivity };
    const result = await handleNodeEvent(
      ctx,
      "mac-node",
      nodeEvent("node.presence.activity", { idleSeconds: 0 }),
      { connId: "conn-1", deviceId: "mac-node", presenceAllowed: false },
    );

    expect(result).toEqual(eventResult("node.presence.activity", "permission_required"));
    expect(updateNodePresenceActivity).not.toHaveBeenCalled();
  });

  it("clears authenticated node activity without requiring Accessibility", async () => {
    const broadcast = vi.fn();
    const clearNodePresenceActivity = vi.fn(() => true);
    const ctx: NodeEventContext = {
      ...buildCtx(),
      broadcast,
      clearNodePresenceActivity,
    };
    const result = await handleNodeEvent(
      ctx,
      "mac-node",
      nodeEvent("node.presence.activity", { action: "clear" }),
      { connId: "conn-1", deviceId: "mac-node", presenceAllowed: false },
    );

    expect(result).toEqual(eventResult("node.presence.activity", "cleared", true));
    expect(clearNodePresenceActivity).toHaveBeenCalledWith({
      nodeId: "mac-node",
      connId: "conn-1",
    });
    expect(broadcast).toHaveBeenCalledWith(
      "node.presence",
      { nodeId: "mac-node", lastActiveAtMs: null, presenceUpdatedAtMs: null },
      { dropIfSlow: true },
    );
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });
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
      loadSessionEntryMock.mockReturnValueOnce({
        ...buildSessionLookup("Main"),
        canonicalKey: "agent:main:main",
      });
      await handleNodeEvent(ctx, "node-c1", nodeEvent(event, { sessionKey: "  Main  " }), {
        connId: "node-c1-connection",
      });
      expect(callback).toHaveBeenCalledWith("node-c1", "agent:main:main", "node-c1-connection");
      expect(loadSessionEntryMock).toHaveBeenCalledWith("Main");
    },
  );
  it("skips the event when the payload is missing a session key", async () => {
    const nodeSubscribe = vi.fn();
    const ctx = { ...buildCtx(), nodeSubscribe };

    await handleNodeEvent(ctx, "node-c3", nodeEvent("chat.subscribe", { other: 1 }));

    expect(nodeSubscribe).not.toHaveBeenCalled();
  });
});
