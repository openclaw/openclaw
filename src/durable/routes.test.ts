import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableReportRoute, recordDurableRouteProgress } from "./routes.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-routes-"));
  const store = openDurableRuntimeSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("durable report routes", () => {
  it("keeps branch progress attached to separate route ids", () => {
    const { store, cleanup } = tempStore();
    try {
      const run = store.createRun({
        operationKind: "route.runtime",
        status: "running",
        recoveryState: "running",
      });
      const childA = createDurableReportRoute({
        store,
        runtimeRunId: run.runtimeRunId,
        routeId: "route-child-a",
        parentRouteId: "route-parent",
        branchId: "child-a",
        channelRef: "channel:main",
      });
      const childB = createDurableReportRoute({
        store,
        runtimeRunId: run.runtimeRunId,
        routeId: "route-child-b",
        parentRouteId: "route-parent",
        branchId: "child-b",
        channelRef: "channel:main",
      });

      recordDurableRouteProgress({
        store,
        runtimeRunId: run.runtimeRunId,
        routeId: "route-child-a",
        branchId: "child-a",
        progressType: "completed",
        summary: "A done",
      });
      recordDurableRouteProgress({
        store,
        runtimeRunId: run.runtimeRunId,
        routeId: "route-child-b",
        branchId: "child-b",
        progressType: "failed",
        summary: "B failed",
      });

      expect(childA.refId).not.toBe(childB.refId);
      expect(store.listRefs(run.runtimeRunId).map((ref) => ref.metadata?.routeId)).toEqual([
        "route-child-a",
        "route-child-b",
      ]);
      expect(
        store
          .getTimeline(run.runtimeRunId)
          .filter((event) => event.eventType === "runtime.route.progress")
          .map((event) => [event.correlationId, event.payload?.branchId, event.payload?.summary]),
      ).toEqual([
        ["route-child-a", "child-a", "A done"],
        ["route-child-b", "child-b", "B failed"],
      ]);
    } finally {
      cleanup();
    }
  });
});
