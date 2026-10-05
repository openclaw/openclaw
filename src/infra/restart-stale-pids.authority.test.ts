import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("./gateway-owner-lease.js").readGatewayOwnerLease>(),
);
const mockGetProcessStartTime = vi.hoisted(() => vi.fn<() => number | null>());
const mockIsPidDefinitelyDead = vi.hoisted(() => vi.fn(() => false));
const mockKillProcessTree = vi.hoisted(() => vi.fn());
const mockSignalProcessTree = vi.hoisted(() =>
  vi.fn<typeof import("../process/kill-tree.js").signalProcessTree>(),
);
const mockCleanupSleep = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

vi.mock("./gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: mockReadGatewayOwnerLease,
}));

vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  getFileLockProcessStartTime: mockGetProcessStartTime,
  isPidDefinitelyDead: mockIsPidDefinitelyDead,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: mockKillProcessTree,
  readUnixProcessGroupMembers: (pid: number) => [pid],
  signalProcessTree: mockSignalProcessTree,
}));

vi.mock("../utils/sleep.js", () => ({ sleep: mockCleanupSleep }));

describe("terminateStaleGatewayPids", () => {
  beforeEach(() => {
    mockReadGatewayOwnerLease.mockReset();
    mockReadGatewayOwnerLease.mockReturnValue(undefined);
    mockGetProcessStartTime.mockReset();
    mockGetProcessStartTime.mockReturnValue(1000);
    mockIsPidDefinitelyDead.mockReset();
    mockIsPidDefinitelyDead.mockReturnValue(false);
    mockKillProcessTree.mockReset();
    mockSignalProcessTree.mockReset();
    mockSignalProcessTree.mockImplementation((_pid, _signal, options) => options?.onComplete?.());
    mockCleanupSleep.mockReset();
    mockCleanupSleep.mockResolvedValue(undefined);
  });

  it.each(["recorded owner", "missing start identity", "dead candidate"])(
    "does not signal a PID with %s",
    async (reason) => {
      if (reason === "recorded owner") {
        mockReadGatewayOwnerLease.mockReturnValue({
          owner: "gateway-owner",
          pid: 576,
          host: "gateway-test-host",
          startedAt: 1000,
          port: 18789,
          mode: "supervised",
          supervisor: { kind: "systemd", name: "openclaw-gateway.service" },
          state: "dead",
          expired: true,
        });
      } else if (reason === "missing start identity") {
        mockGetProcessStartTime.mockReturnValue(null);
      } else {
        mockIsPidDefinitelyDead.mockReturnValue(true);
      }
      const { terminateStaleGatewayPids } = await import("./restart-stale-pids.js");
      expect(await terminateStaleGatewayPids([576])).toEqual([]);
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(mockSignalProcessTree).not.toHaveBeenCalled();
      expect(mockCleanupSleep).not.toHaveBeenCalled();
    },
  );
});
