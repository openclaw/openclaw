import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";

const getHealthSnapshotMock = vi.fn();

vi.mock("../../commands/health.js", () => ({
  getHealthSnapshot: (...args: unknown[]) => getHealthSnapshotMock(...args),
}));

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.resetModules();
    getHealthSnapshotMock.mockReset();
    getHealthSnapshotMock.mockResolvedValue({
      ok: true,
      ts: Date.now(),
      durationMs: 1,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      defaultAgentId: "main",
      agents: [],
      sessions: {
        path: "/tmp/sessions.json",
        count: 0,
        recent: [],
      },
    });
  });

  it("passes the live runtime snapshot into health snapshot refreshes", async () => {
    const mod = await import("./health-state.js");
    const runtimeSnapshot: ChannelRuntimeSnapshot = {
      channels: {
        telegram: {
          accountId: "default",
          running: true,
          lastStartAt: 123,
        },
      },
      channelAccounts: {
        telegram: {
          default: {
            accountId: "default",
            running: true,
            lastStartAt: 123,
          },
        },
      },
    };

    mod.setHealthRuntimeSnapshotProvider(() => runtimeSnapshot);
    await mod.refreshGatewayHealthSnapshot({ probe: false });

    expect(getHealthSnapshotMock).toHaveBeenCalledWith({
      probe: false,
      runtimeSnapshot,
    });
    mod.setHealthRuntimeSnapshotProvider(null);
  });
});
