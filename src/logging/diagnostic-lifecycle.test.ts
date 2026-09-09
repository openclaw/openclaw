import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordCommandPoll } from "../agents/command-poll-backoff.js";
import { detectToolCallLoop, recordToolCall } from "../agents/tool-loop-detection.js";
import { registerChannelIngressDiagnosticSource } from "../channels/message/ingress-diagnostic-registry.js";
import { createChannelIngressMonitor } from "../channels/message/ingress-monitor.js";
import type { ChannelIngressObservabilitySnapshot } from "../channels/message/ingress-observability-contract.js";
import { createUnknownChannelIngressObservabilitySnapshot as createUnknownDiagnosticIngressSnapshot } from "../channels/message/ingress-observability-snapshot.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
  peekDiagnosticSessionState,
} from "./diagnostic-session-state.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

function setDiagnosticIngressSnapshotProvider(
  provider: (
    now: number,
  ) => ChannelIngressObservabilitySnapshot | Promise<ChannelIngressObservabilitySnapshot>,
): () => void {
  return registerChannelIngressDiagnosticSource({
    getActiveOperations: () => [],
    getSnapshot: provider,
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  resetDiagnosticStateForTest();
  setDiagnosticsEnabledForProcess(true);
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves independent tool-loop and poll-backoff policy when diagnostic observation stops", () => {
  const session = { sessionKey: "diagnostic-tool-history" };
  const state = getDiagnosticSessionState(session);
  const args = { path: "fixture.txt" };
  for (let index = 0; index < 10; index += 1) {
    recordToolCall(state, "read", args);
  }
  const before = detectToolCallLoop(state, "read", args, { enabled: true });
  expect(before).toMatchObject({ stuck: true, detector: "generic_repeat", count: 10 });
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(5_000);
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(10_000);
  setDiagnosticsEnabledForProcess(false);
  stopDiagnosticHeartbeat();
  const current = getDiagnosticSessionState(session);
  expect(detectToolCallLoop(current, "read", args, { enabled: true })).toEqual(before);
  expect(recordCommandPoll(current, "fixture-command", false)).toBe(30_000);
});

it("emits ingress snapshots before idle heartbeat returns", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const sampledAt = new Date("2026-01-01T00:00:00.000Z").getTime();
  vi.setSystemTime(sampledAt);
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const cleanupProvider = setDiagnosticIngressSnapshotProvider(async (now) => ({
    ...createUnknownDiagnosticIngressSnapshot(now),
    status: "known",
  }));
  try {
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });

    await vi.advanceTimersByTimeAsync(15_000);
    await waitForDiagnosticEventsDrained();

    expect(events.filter((event) => event.type === "diagnostic.heartbeat")).toHaveLength(0);
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([
      expect.objectContaining({
        type: "ingress.snapshot",
        schemaVersion: 1,
        sampledAt: sampledAt + 15_000,
        status: "known",
        isolationAvailable: false,
      }),
    ]);
  } finally {
    cleanupProvider();
    unsubscribe();
  }
});

it("emits unknown ingress snapshots while an async ingress provider remains pending", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startedAt = new Date("2026-01-01T00:00:00.000Z").getTime();
  vi.setSystemTime(startedAt);
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const deferredSnapshots: Array<Deferred<ChannelIngressObservabilitySnapshot>> = [];
  const infoSpy = vi.spyOn(diagnosticLogger, "info").mockImplementation(() => undefined);
  const ingressLogPayloads = () =>
    infoSpy.mock.calls
      .filter(([message]) => message === "ingress.snapshot")
      .map(([, payload]) => payload);
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const cleanupProvider = setDiagnosticIngressSnapshotProvider(() => {
    const deferred = createDeferred<ChannelIngressObservabilitySnapshot>();
    deferredSnapshots.push(deferred);
    return deferred.promise;
  });
  try {
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(deferredSnapshots).toHaveLength(1);
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([]);

    await vi.advanceTimersByTimeAsync(15_000);
    await waitForDiagnosticEventsDrained();
    expect(deferredSnapshots).toHaveLength(1);
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([
      expect.objectContaining({
        sampledAt: startedAt + 30_000,
        status: "unknown",
      }),
    ]);

    await vi.advanceTimersByTimeAsync(15_000);
    await waitForDiagnosticEventsDrained();
    expect(deferredSnapshots).toHaveLength(1);
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([
      expect.objectContaining({
        sampledAt: startedAt + 30_000,
        status: "unknown",
      }),
      expect.objectContaining({
        sampledAt: startedAt + 45_000,
        status: "unknown",
      }),
    ]);

    deferredSnapshots[0]?.resolve({
      ...createUnknownDiagnosticIngressSnapshot(startedAt + 15_000),
      status: "known",
      failedCount: 1,
    });
    await flushMicrotasks();
    await waitForDiagnosticEventsDrained();
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([
      expect.objectContaining({
        sampledAt: startedAt + 30_000,
        status: "unknown",
      }),
      expect.objectContaining({
        sampledAt: startedAt + 45_000,
        status: "unknown",
      }),
    ]);
    expect(ingressLogPayloads()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sampledAt: startedAt + 15_000,
          failedCount: 1,
          status: "known",
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(deferredSnapshots).toHaveLength(2);

    deferredSnapshots[1]?.resolve({
      ...createUnknownDiagnosticIngressSnapshot(startedAt + 60_000),
      status: "known",
      failedCount: 2,
    });
    await flushMicrotasks();
    await waitForDiagnosticEventsDrained();
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([
      expect.objectContaining({
        sampledAt: startedAt + 30_000,
        status: "unknown",
      }),
      expect.objectContaining({
        sampledAt: startedAt + 45_000,
        status: "unknown",
      }),
      expect.objectContaining({
        sampledAt: startedAt + 60_000,
        failedCount: 2,
        status: "known",
      }),
    ]);
    expect(events.filter((event) => event.type === "ingress.snapshot")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sampledAt: startedAt + 15_000,
          failedCount: 1,
          status: "known",
        }),
      ]),
    );
    expect(ingressLogPayloads()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sampledAt: startedAt + 15_000,
          failedCount: 1,
          status: "known",
        }),
      ]),
    );
  } finally {
    cleanupProvider();
    unsubscribe();
    infoSpy.mockRestore();
  }
});

it("emits ingress snapshots from the registered channel ingress monitor", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout"] });
  const sampledAt = new Date("2026-01-01T00:00:00.000Z").getTime();
  vi.setSystemTime(sampledAt);
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const stateDir = tempDirs.make("obs-core-diagnostic-");
  const queue = createChannelIngressQueue<{ version: 1; rawEvent: string }>({
    channelId: "slack",
    accountId: "workspace",
    stateDir,
    now: () => Date.now(),
  });
  let releaseDelivery = () => {};
  const deliveryHeld = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  let markDeliveryStarted = () => {};
  const deliveryStarted = new Promise<void>((resolve) => {
    markDeliveryStarted = resolve;
  });
  const monitor = createChannelIngressMonitor<
    { id: string; lane: string; text: string },
    string,
    { version: 1; rawEvent: string }
  >({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as { id: string; lane: string; text: string },
      createClaimError: (kind) => new Error(kind),
    },
    deliver: async (_raw, lifecycle) => {
      lifecycle.observer?.stage("thread_history", "slack_api");
      const ticket = lifecycle.observer?.begin({
        kind: "api",
        method: "conversations.replies",
        profile: "slack-web",
      });
      markDeliveryStarted();
      await deliveryHeld;
      ticket?.finish("completed");
      await lifecycle.onAdopted();
    },
    pollIntervalMs: 1_000,
    retention: { pruneIntervalMs: 60_000 },
    drain: { adoptionStallTimeoutMs: 60_000 },
    now: () => Date.now(),
  });
  try {
    monitor.start();
    await monitor.admit(
      { id: "event-1", lane: "thread", text: "hello" },
      {
        receivedAt: sampledAt,
      },
    );
    await vi.waitFor(async () => {
      await deliveryStarted;
    });

    const heartbeatStartedAt = Date.now();
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    await vi.advanceTimersByTimeAsync(15_000);
    await waitForDiagnosticEventsDrained();

    await vi.waitFor(
      async () => {
        await waitForDiagnosticEventsDrained();
        const ingressSnapshot = events.findLast((event) => event.type === "ingress.snapshot");
        expect(ingressSnapshot).toMatchObject({
          type: "ingress.snapshot",
          schemaVersion: 1,
          sampledAt: heartbeatStartedAt + 15_000,
          status: "known",
          isolationAvailable: false,
          stages: {
            thread_history: {
              total: 1,
              blockers: { slack_api: { total: 1 } },
            },
          },
          operations: {
            api: {
              total: 1,
              known: true,
              oldest: {
                eventId: "event-1",
                queueName: '["slack","workspace"]',
                channelId: "slack",
                accountId: "workspace",
                method: "conversations.replies",
                profile: "slack-web",
              },
            },
          },
        });
      },
      { interval: 10, timeout: 1_000 },
    );
    expect(events.filter((event) => event.type === "ingress.snapshot")).toHaveLength(1);
  } finally {
    releaseDelivery();
    await monitor.stop();
    unsubscribe();
  }
});

it("does not publish or unblock a restarted heartbeat from an obsolete async ingress snapshot", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startedAt = new Date("2026-01-01T00:00:00.000Z").getTime();
  vi.setSystemTime(startedAt);
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const deferredSnapshots: Array<Deferred<ChannelIngressObservabilitySnapshot>> = [];
  const requestedSampleTimes: number[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const cleanupProvider = setDiagnosticIngressSnapshotProvider((now) => {
    requestedSampleTimes.push(now);
    const deferred = createDeferred<ChannelIngressObservabilitySnapshot>();
    deferredSnapshots.push(deferred);
    return deferred.promise;
  });
  try {
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deferredSnapshots).toHaveLength(1);

    stopDiagnosticHeartbeat();
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deferredSnapshots).toHaveLength(2);

    deferredSnapshots[0]?.resolve({
      ...createUnknownDiagnosticIngressSnapshot(requestedSampleTimes[0] ?? startedAt),
      status: "known",
      failedCount: 1,
    });
    await flushMicrotasks();
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([]);

    await vi.advanceTimersByTimeAsync(15_000);
    await waitForDiagnosticEventsDrained();
    expect(deferredSnapshots).toHaveLength(2);
    expect(events.filter((event) => event.type === "ingress.snapshot")).toEqual([
      expect.objectContaining({
        sampledAt: startedAt + 45_000,
        status: "unknown",
      }),
    ]);

    deferredSnapshots[1]?.resolve({
      ...createUnknownDiagnosticIngressSnapshot(requestedSampleTimes[1] ?? startedAt),
      status: "known",
      failedCount: 2,
    });
    await flushMicrotasks();
    await waitForDiagnosticEventsDrained();

    const ingressSnapshots = events.filter((event) => event.type === "ingress.snapshot");
    expect(ingressSnapshots).toEqual([
      expect.objectContaining({
        sampledAt: startedAt + 45_000,
        status: "unknown",
      }),
    ]);
    expect(ingressSnapshots).not.toContainEqual(
      expect.objectContaining({
        failedCount: 1,
        status: "known",
      }),
    );
    expect(ingressSnapshots).not.toContainEqual(
      expect.objectContaining({
        failedCount: 2,
        status: "known",
      }),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(deferredSnapshots).toHaveLength(3);
  } finally {
    cleanupProvider();
    unsubscribe();
  }
});

it("retires interrupted diagnostic observations before re-enable without reviving their authority", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const session = { sessionKey: "diagnostic-lifecycle", sessionId: "diagnostic-lifecycle" };
  try {
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    const generation = peekDiagnosticSessionState(session)?.generation;
    expect(generation).toBeTypeOf("number");
    setDiagnosticsEnabledForProcess(false);
    stopDiagnosticHeartbeat();
    logSessionStateChange({ ...session, state: "idle" });
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
    logWebhookReceived({ channel: "test" });
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForDiagnosticEventsDrained();
    expect(events.findLast((event) => event.type === "diagnostic.heartbeat")).toMatchObject({
      active: 0,
      queued: 0,
      waiting: 0,
    });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    expect(isDiagnosticSessionStateCurrent({ ...session, generation, state: "processing" })).toBe(
      false,
    );
  } finally {
    unsubscribe();
  }
});
