import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const hoisted = vi.hoisted(() => {
  const getActiveEmbeddedRunCountMock = vi.fn(() => 0);
  const getTotalPendingRepliesMock = vi.fn(() => 0);
  const getTotalQueueSizeMock = vi.fn(() => 0);
  const getObservabilitySnapshotMock = vi.fn(() => ({
    turns: { active: 0, queueDepth: 0 },
  }));

  return {
    getActiveEmbeddedRunCountMock,
    getTotalPendingRepliesMock,
    getTotalQueueSizeMock,
    getObservabilitySnapshotMock,
  };
});

vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunCount: hoisted.getActiveEmbeddedRunCountMock,
}));

vi.mock("../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: hoisted.getTotalPendingRepliesMock,
}));

vi.mock("../process/command-queue.js", () => ({
  getTotalQueueSize: hoisted.getTotalQueueSizeMock,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    getObservabilitySnapshot: hoisted.getObservabilitySnapshotMock,
  }),
}));

const { formatGatewayRestartDeferralDetails, getGatewayRestartDeferralCounts } =
  await import("./restart-deferral.js");

describe("gateway restart deferral counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getActiveEmbeddedRunCountMock.mockReturnValue(0);
    hoisted.getTotalPendingRepliesMock.mockReturnValue(0);
    hoisted.getTotalQueueSizeMock.mockReturnValue(0);
    hoisted.getObservabilitySnapshotMock.mockReturnValue({
      turns: { active: 0, queueDepth: 0 },
    });
  });

  it("includes ACP turns without double-counting active vs queue depth", () => {
    hoisted.getTotalQueueSizeMock.mockReturnValue(5);
    hoisted.getTotalPendingRepliesMock.mockReturnValue(4);
    hoisted.getActiveEmbeddedRunCountMock.mockReturnValue(3);
    hoisted.getObservabilitySnapshotMock.mockReturnValue({
      turns: { active: 1, queueDepth: 2 },
    });

    const counts = getGatewayRestartDeferralCounts({} as OpenClawConfig);

    expect(counts).toMatchObject({
      queueSize: 5,
      pendingReplies: 4,
      embeddedRuns: 3,
      acpActiveTurns: 1,
      acpQueueDepth: 2,
      acpTurns: 2,
      totalActive: 14,
    });
    expect(formatGatewayRestartDeferralDetails(counts)).toEqual([
      "5 operation(s)",
      "4 reply(ies)",
      "3 embedded run(s)",
      "2 ACP turn(s)",
    ]);
  });
});
