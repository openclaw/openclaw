export type SessionDataProbeOwner = {
  requestSessionDataUpdate: (...args: unknown[]) => unknown;
};
export type SolidSidebarProbeOwner = {
  readonly hostElement: HTMLElement;
  readonly isConnected: boolean;
  sessionData: SessionDataProbeOwner;
  invalidate(): void;
  prepareRender(): void;
  commitRender(): void;
};
export type SidebarLifecycle = "invalidate" | "prepareRender" | "commitRender";
export type ProbeMethod = (...args: unknown[]) => unknown;
export type ChatProbeOwner = {
  readonly element: HTMLElement;
  readonly isConnected: boolean;
  render: ProbeMethod;
};
export type ChatOwnerRecord = {
  host: HTMLElement;
  owner: ChatProbeOwner;
  originalRender?: ProbeMethod;
  pending: Map<string, number>;
  pendingRequests: Map<number, string>;
};

export type ColdLoadProbeInput = {
  ownerProbes?: boolean;
  latencyMs: number;
  methodLatencyMs?: Record<string, number>;
  frameGapMs: number;
  events: Array<{ event: string; payload: unknown }>;
  liveEvents?: Array<{
    atMs: number;
    kind: string;
    event: string;
    payload: unknown;
    history?: { text?: string; message?: unknown };
    sessionMutation?: {
      upsert?: import("../api/types.ts").GatewaySessionRow[];
      removeKeys?: string[];
    };
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
    request: (callback: FrameRequestCallback): number => {
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
      origin.frameId = frameProbe.original.call(
        window,
        function (this: unknown, timestamp: number) {
          const previous = activeFrameOrigin;
          const { startedAt, finishedAt } = readWindow();
          activeFrameOrigin = startedAt && !finishedAt ? origin : null;
          try {
            callback.call(this, timestamp);
          } finally {
            activeFrameOrigin = previous;
          }
        },
      );
      frameOrigins.set(origin.id, origin);
      return origin.frameId;
    },
    install() {
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
