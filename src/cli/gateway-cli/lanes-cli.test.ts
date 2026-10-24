import { describe, expect, it, vi } from "vitest";
import { renderLanesSummary } from "./lanes-cli.js";

describe("renderLanesSummary", () => {
  it("renders lane rows and worker totals without color when rich is false", () => {
    const lines = renderLanesSummary(
      {
        ts: 42,
        lanes: [
          {
            lane: "main",
            queuedCount: 1,
            activeCount: 2,
            maxConcurrent: 16,
            draining: true,
            blockedBy: "lane",
          },
          {
            lane: "hook-dispatch",
            queuedCount: 0,
            activeCount: 1,
            maxConcurrent: 4,
            group: "cron-hooks",
            groupActive: 2,
            groupBudget: 4,
            blockedBy: "group-budget",
          },
        ],
        dynamic: { laneCount: 3, activeCount: 1, queuedCount: 2, queuedLaneCount: 1 },
        workerCount: 4,
        workerPoolCount: 2,
      },
      false,
    );
    expect(lines[0]).toBe("Gateway Lanes");
    expect(lines).toContain("Ts: 42");
    expect(lines).toContain("main: active=2 · queued=1 · max=16 · draining · blockedBy=lane");
    expect(lines).toContain(
      "hook-dispatch: active=1 · queued=0 · max=4 · blockedBy=group-budget · group=cron-hooks(2/4)",
    );
    expect(lines).toContain("Dynamic: lanes=3 · active=1 · queued=2 · queuedLanes=1");
    expect(lines).toContain("Workers: count=4 · pools=2");
  });

  it("reports empty lanes when payload is missing", () => {
    expect(renderLanesSummary(undefined, false)).toEqual(["Gateway Lanes", "No lanes reported."]);
  });
});
