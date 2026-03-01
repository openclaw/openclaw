import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { onDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getAllLaneInfo } from "../process/command-queue.js";
import type { LaneSnapshot, QueueTimeline } from "./types.js";

/**
 * Subscribes to diagnostic events and periodically snapshots lane state.
 * Optionally filters by a lane prefix (e.g. `sim:{runId}:`).
 */
export class QueueMonitor {
  private timeline: QueueTimeline = { snapshots: [], events: [] };
  private dispose?: () => void;
  private interval?: ReturnType<typeof setInterval>;
  private lanePrefix?: string;

  start(sampleIntervalMs: number, lanePrefix?: string): void {
    this.lanePrefix = lanePrefix;

    this.dispose = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
      // Only capture events relevant to simulation lanes
      if (this.lanePrefix && "lane" in evt && typeof evt.lane === "string") {
        if (!evt.lane.startsWith(this.lanePrefix)) {
          return;
        }
      }
      this.timeline.events.push(evt);
    });

    this.interval = setInterval(() => {
      const allLanes = getAllLaneInfo(this.lanePrefix);
      for (const info of allLanes) {
        const snap: LaneSnapshot = {
          ts: Date.now(),
          lane: info.lane,
          queued: info.queued,
          active: info.active,
          maxConcurrent: info.maxConcurrent,
        };
        this.timeline.snapshots.push(snap);
      }
    }, sampleIntervalMs);
  }

  stop(): QueueTimeline {
    this.dispose?.();
    this.dispose = undefined;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    return this.timeline;
  }
}
