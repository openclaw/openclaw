// Covers the shared active-work snapshot used by restart and host-suspension decisions.
import { describe, expect, it } from "vitest";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";

function inspectors(
  overrides: Partial<GatewayActiveWorkInspectors> = {},
): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
    getBackgroundExecCount: () => 0,
    ...overrides,
  };
}

describe("gateway active work snapshot", () => {
  it("reports idle when all inspectors return zero", () => {
    const snapshot = createGatewayActiveWorkSnapshot(inspectors());
    expect(snapshot.idle).toBe(true);
    expect(snapshot.counts.totalActive).toBe(0);
    expect(snapshot.blockers).toHaveLength(0);
  });

  it("includes a background-exec count blocker", () => {
    const snapshot = createGatewayActiveWorkSnapshot(
      inspectors({ getBackgroundExecCount: () => 3 }),
    );
    expect(snapshot.idle).toBe(false);
    expect(snapshot.counts.backgroundExec).toBe(3);
    expect(snapshot.counts.totalActive).toBe(3);
    expect(snapshot.blockers).toEqual([
      {
        kind: "background-exec",
        count: 3,
        message: "3 running background exec session(s)",
      },
    ]);
  });

  it("normalizes negative or non-finite counts to zero", () => {
    const snapshot = createGatewayActiveWorkSnapshot(
      inspectors({ getBackgroundExecCount: () => Number.NaN }),
    );
    expect(snapshot.counts.backgroundExec).toBe(0);
    expect(snapshot.blockers).toHaveLength(0);
    expect(snapshot.idle).toBe(true);
  });

  it("aggregates background-exec into totalActive alongside other work", () => {
    const snapshot = createGatewayActiveWorkSnapshot(
      inspectors({
        getQueueSize: () => 2,
        getBackgroundExecCount: () => 4,
      }),
    );
    expect(snapshot.counts.totalActive).toBe(6);
    expect(snapshot.blockers.map((b) => b.kind)).toEqual(["queue", "background-exec"]);
  });
});
