import { installColdLoadProbes } from "./control-ui-cold-load-probes.ts";

export type ColdLoadProbeInput = {
  latencyMs: number;
  frameGapMs: number;
  events: Array<{ event: string; payload: unknown }>;
  liveEvents?: Array<{
    atMs: number;
    kind: string;
    event: string;
    payload: unknown;
    history?: { text?: string; message?: unknown };
  }>;
  liveHistory?: {
    sessionId: string;
    sessionInfo: unknown;
    messages: unknown[];
    inFlightRun: { runId: string; text: string; startedAt: number; events: unknown[] };
  };
};

type LiveDeliveryOrigin = {
  index: number;
  kind: string;
  event: string;
  plannedAtMs: number;
  queuedAtMs: number;
  deliveredAtMs: number;
};

/** Serialized with the main probe; all runtime dependencies belong to this function. */
export function createColdLoadFrameProbe(
  readWindow: () => { startedAt: number; finishedAt: number },
) {
  type FrameOrigin = {
    id: number;
    frameId: number;
    scheduledAtMs: number;
    schedulingStack: string;
    delivery: LiveDeliveryOrigin | null;
    parentId: number | null;
  };
  let activeLiveDelivery: LiveDeliveryOrigin | null = null;
  let activeFrameOrigin: FrameOrigin | null = null;
  const frameOrigins = new Map<number, FrameOrigin>();
  const liveDeliveries: Array<LiveDeliveryOrigin & { gapMs: number | null }> = [];
  const frameProbe = {
    original: window.requestAnimationFrame,
    request(this: Window, callback: FrameRequestCallback): number {
      if (frameOrigins.size >= 5000) {
        throw new Error("Live frame scheduling origin limit exceeded");
      }
      const origin: FrameOrigin = {
        id: frameOrigins.size + 1,
        frameId: 0,
        scheduledAtMs: performance.now() - readWindow().startedAt,
        schedulingStack: new Error().stack?.split("\n").slice(2, 18).join(" <- ") ?? "",
        delivery: activeLiveDelivery,
        parentId: activeFrameOrigin?.id ?? null,
      };
      origin.frameId = frameProbe.original.call(this, function (this: unknown, timestamp: number) {
        const previous = activeFrameOrigin;
        const { startedAt, finishedAt } = readWindow();
        activeFrameOrigin = startedAt && !finishedAt ? origin : null;
        try {
          callback.call(this, timestamp);
        } finally {
          activeFrameOrigin = previous;
        }
      });
      frameOrigins.set(origin.id, origin);
      return origin.frameId;
    },
    install() {
      // oxlint-disable-next-line typescript/unbound-method -- Installed as a window method; forwards that receiver to the native frame owner.
      window.requestAnimationFrame = frameProbe.request;
    },
    restore() {
      if (window.requestAnimationFrame === frameProbe.request) {
        window.requestAnimationFrame = frameProbe.original;
      }
    },
    currentOriginId() {
      return activeFrameOrigin?.id ?? null;
    },
    withDelivery<T>(delivery: LiveDeliveryOrigin | null, dispatch: () => T): T {
      if (delivery) {
        const previous = liveDeliveries.at(-1);
        liveDeliveries.push({
          ...delivery,
          gapMs: previous ? delivery.deliveredAtMs - previous.deliveredAtMs : null,
        });
      }
      const previous = activeLiveDelivery;
      activeLiveDelivery = delivery;
      try {
        return dispatch();
      } finally {
        activeLiveDelivery = previous;
      }
    },
    read() {
      return {
        frameOrigins: Object.fromEntries(frameOrigins),
        frameOriginCoverage: "captured-live-schedules-only; pre-live-frames-have-null-origin",
      };
    },
    readDeliveryCadence() {
      return {
        events: liveDeliveries,
        adjacentGapThresholdMs: 16,
        shortAdjacentGaps: liveDeliveries.filter(
          (delivery) => delivery.gapMs !== null && delivery.gapMs < 16,
        ).length,
        maxLatenessMs: Math.max(
          0,
          ...liveDeliveries.map((delivery) => delivery.deliveredAtMs - delivery.plannedAtMs),
        ),
      };
    },
  };
  return frameProbe;
}

export function createColdLoadProbeInitScript(input: ColdLoadProbeInput): string {
  return `(${installColdLoadProbes.toString()})(${JSON.stringify(input)}, ${createColdLoadFrameProbe.toString()});`;
}
