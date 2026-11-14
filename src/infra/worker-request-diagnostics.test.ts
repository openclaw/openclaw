import type { EventLoopUtilization } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { onWorkerRequestMetrics, trackWorkerRequest } from "./worker-request-diagnostics.js";

const { report } = vi.hoisted(() => ({ report: vi.fn() }));
// mock-isolation: Keep the logging sink outside the worker timing fixture.
vi.mock("./worker-request-delivery-report.runtime.js", () => ({
  reportSlowWorkerDelivery: report,
}));

afterEach(() => report.mockClear());

function workerLoop() {
  const totals = { active: 0, idle: 0 };
  return {
    totals,
    performance: {
      eventLoopUtilization: (previous?: EventLoopUtilization): EventLoopUtilization => {
        const active = totals.active - (previous?.active ?? 0);
        const idle = totals.idle - (previous?.idle ?? 0);
        return { active, idle, utilization: active / (active + idle || 1) };
      },
    },
  };
}

it.each([
  { deliveryMs: 4_944, reported: true },
  { deliveryMs: 999, reported: false },
])(
  "names the worker loop state behind a $deliveryMs ms delivery",
  async ({ deliveryMs, reported }) => {
    // Timing stamps exist only while an exporter consumes them.
    const stop = onWorkerRequestMetrics(() => {});
    try {
      const loop = workerLoop();
      loop.totals.active = 50_000;
      const observation = trackWorkerRequest(
        "sqlite_writer",
        "session.actor.appendTranscriptEvent",
      );
      observation.started(14, loop.performance);
      Object.assign(observation.timing!, {
        posted: 1_000,
        received: 1_000 + deliveryMs,
        executeStarted: 1_001 + deliveryMs,
        executeFinished: 1_360 + deliveryMs,
      });
      loop.totals.active += deliveryMs + 359;
      loop.totals.idle += 5;
      observation.completed();
      await vi.dynamicImportSettled();
      if (!reported) {
        expect(report).not.toHaveBeenCalled();
        return;
      }
      expect(report).toHaveBeenCalledExactlyOnceWith({
        requestClass: expect.any(String),
        threadId: 14,
        deliveryMs: 4_944,
        executeMs: 359,
        workerActiveMs: 5_303,
        workerIdleMs: 5,
        workerActiveOutsideExecuteMs: 4_944,
      });
    } finally {
      stop();
    }
  },
);
