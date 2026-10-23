import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../logging/diagnostic-stability.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { diagnosticsHandlers } from "./diagnostics.js";

type LaneDiagnosticsPayload = {
  ts: number;
} & ReturnType<typeof getCommandLaneDiagnostics>;

async function requestDiagnostics(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await expectDefined(
    diagnosticsHandlers[method],
    method,
  )({
    req: { type: "req", id: "diagnostics", method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    context: {} as never,
    respond,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond;
}

async function requestLaneDiagnostics(): Promise<LaneDiagnosticsPayload> {
  return (await requestDiagnostics("diagnostics.lanes")).mock
    .calls[0]?.[1] as LaneDiagnosticsPayload;
}

async function blockLane(lane: string) {
  const started = createDeferred();
  const release = createDeferred();
  const active = enqueueCommandInLane(lane, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  return { active, release: release.resolve };
}

async function expectLane(lane: string, state: Partial<LaneDiagnosticsPayload["lanes"][number]>) {
  expect((await requestLaneDiagnostics()).lanes).toContainEqual(
    expect.objectContaining({ lane, ...state }),
  );
}

describe("diagnostics gateway methods", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    startDiagnosticStabilityRecorder();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });

  it("returns a filtered stability snapshot", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    const event = {
      type: "payload.large" as const,
      surface: "gateway.http.json",
      action: "rejected" as const,
      bytes: 1024,
      limitBytes: 512,
    };
    emitDiagnosticEvent(event);

    const respond = await requestDiagnostics("diagnostics.stability", {
      type: "payload.large",
      limit: 10,
    });
    const firstRespondCall = respond.mock.calls[0];
    expect(firstRespondCall).toStrictEqual([
      true,
      {
        generatedAt: now.toISOString(),
        capacity: 1000,
        count: 1,
        dropped: 0,
        firstSeq: 2,
        lastSeq: 2,
        events: [
          {
            seq: 2,
            ts: now.getTime(),
            ...event,
            count: undefined,
            channel: undefined,
            pluginId: undefined,
          },
        ],
        summary: {
          byType: { "payload.large": 1 },
          payloadLarge: {
            count: 1,
            rejected: 1,
            truncated: 0,
            chunked: 0,
            bySurface: { "gateway.http.json": 1 },
          },
        },
      },
      undefined,
    ]);
  });

  it("rejects invalid stability params", async () => {
    const respond = await requestDiagnostics("diagnostics.stability", { limit: 0 });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "limit must be between 1 and 1000",
    });
  });

  it("reports static lanes in sorted order and hides disabled lanes only after work drains", async () => {
    const lane = CommandLane.HookDispatch;
    const originalConcurrency = getCommandLaneSnapshot(lane).maxConcurrent;
    setCommandLaneConcurrency(lane, 1);

    const { active, release } = await blockLane(lane);
    let queued: Promise<void> | undefined;

    try {
      setCommandLaneConcurrency(lane, 0);
      await expectLane(lane, { activeCount: 1, queuedCount: 0, maxConcurrent: 0 });
      setCommandLaneConcurrency(lane, 1);
      queued = enqueueCommandInLane(lane, async () => undefined);
      const payload = await requestLaneDiagnostics();
      expect(payload.ts).toBeGreaterThan(0);
      expect(payload.lanes.map((snapshot) => snapshot.lane)).toEqual([
        CommandLane.ActiveMemory,
        CommandLane.Background,
        CommandLane.Cron,
        CommandLane.CronNested,
        CommandLane.HookDispatch,
        CommandLane.Main,
        CommandLane.Nested,
        CommandLane.RestartRecovery,
        CommandLane.Subagent,
        CommandLane.SystemAgent,
        CommandLane.SystemAgentInference,
      ]);
      await expectLane(lane, {
        activeCount: 1,
        queuedCount: 1,
        maxConcurrent: 1,
        blockedBy: "lane",
      });

      setCommandLaneConcurrency(lane, 0);
      release();
      await active;
      await expectLane(lane, { activeCount: 0, queuedCount: 1, maxConcurrent: 0 });

      setCommandLaneConcurrency(lane, 1);
      await queued;
      await expectLane(lane, { activeCount: 0, queuedCount: 0, maxConcurrent: 1 });

      setCommandLaneConcurrency(lane, 0);
      expect((await requestLaneDiagnostics()).lanes.map((snapshot) => snapshot.lane)).not.toContain(
        lane,
      );
    } finally {
      release();
      setCommandLaneConcurrency(lane, 1);
      await Promise.all([active, queued]);
      setCommandLaneConcurrency(lane, originalConcurrency);
    }
  });

  it("reports subagent totals with per-session capacity without exposing parent identities", async () => {
    const before = await requestLaneDiagnostics();
    const originalConcurrency = getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent;
    const parentA = "subagent:agent:main:private-parent-a";
    const parents = [parentA, "subagent:agent:main:private-parent-b"];
    const gate = createDeferred();
    setCommandLaneConcurrency(CommandLane.Subagent, 3);
    const runs = parents.flatMap((lane) =>
      Array.from({ length: 2 }, () => enqueueCommandInLane(lane, async () => await gate.promise)),
    );
    try {
      let payload = await requestLaneDiagnostics();
      expect(payload.lanes.find((lane) => lane.lane === "subagent")).toMatchObject({
        activeCount: 4,
        queuedCount: 0,
        maxConcurrent: 3,
        concurrencyScope: "session",
        saturatedLaneCount: 0,
        blockedBy: null,
      });
      runs.push(
        enqueueCommandInLane(parentA, async () => await gate.promise),
        enqueueCommandInLane(parentA, async () => await gate.promise),
      );
      payload = await requestLaneDiagnostics();
      expect(payload.lanes.find((lane) => lane.lane === "subagent")).toMatchObject({
        activeCount: 5,
        queuedCount: 1,
        maxConcurrent: 3,
        concurrencyScope: "session",
        saturatedLaneCount: 1,
        blockedBy: "lane",
      });
      expect(payload.dynamic).toEqual(before.dynamic);
      expect(JSON.stringify(payload)).not.toContain("private-parent");
    } finally {
      gate.resolve();
      await Promise.all(runs);
      setCommandLaneConcurrency(CommandLane.Subagent, originalConcurrency);
    }
  });

  it("aggregates saturated dynamic lanes without exporting their names", async () => {
    const lane = `test:diagnostics-${Date.now()}`;
    const before = await requestLaneDiagnostics();
    setCommandLaneConcurrency(lane, 1);

    const { active, release } = await blockLane(lane);
    const queued = enqueueCommandInLane(lane, async () => undefined);

    try {
      const payload = await requestLaneDiagnostics();
      const baseline = before.dynamic;
      expect(payload.lanes.map((snapshot) => snapshot.lane)).not.toContain(lane);
      expect(payload.dynamic).toEqual({
        laneCount: (baseline?.laneCount ?? 0) + 1,
        activeCount: (baseline?.activeCount ?? 0) + 1,
        queuedCount: (baseline?.queuedCount ?? 0) + 1,
        queuedLaneCount: (baseline?.queuedLaneCount ?? 0) + 1,
      });
    } finally {
      release();
      await Promise.all([active, queued]);
    }
  });
});
