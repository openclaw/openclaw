import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(async () => {
    const mod = await import("./health-state.js");
    mod.setHealthRuntimeSnapshotProvider(null);
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
  });

  it("treats cached health as stale when runtime is newer", async () => {
    const mod = await import("./health-state.js");
    const runtimeSnapshot: ChannelRuntimeSnapshot = {
      channels: {
        telegram: {
          accountId: "default",
          running: true,
          lastStartAt: 456,
        },
      },
      channelAccounts: {
        telegram: {
          default: {
            accountId: "default",
            running: true,
            lastStartAt: 456,
          },
        },
      },
    };

    mod.setHealthRuntimeSnapshotProvider(() => runtimeSnapshot);

    expect(
      mod.isGatewayHealthCacheStale({
        ok: true,
        ts: Date.now(),
        durationMs: 1,
        channels: {
          telegram: {
            accountId: "default",
            configured: true,
            running: false,
            lastStartAt: null,
          },
        },
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        heartbeatSeconds: 0,
        defaultAgentId: "main",
        agents: [],
        sessions: {
          path: "/tmp/sessions.json",
          count: 0,
          recent: [],
        },
      }),
    ).toBe(true);
  });

  it("does not perpetually invalidate when cached summary omits lastStartAt", async () => {
    const mod = await import("./health-state.js");
    const runtimeSnapshot: ChannelRuntimeSnapshot = {
      channels: {
        whatsapp: {
          accountId: "default",
          running: true,
          lastStartAt: 789,
        },
      },
      channelAccounts: {
        whatsapp: {
          default: {
            accountId: "default",
            running: true,
            lastStartAt: 789,
          },
        },
      },
    };

    mod.setHealthRuntimeSnapshotProvider(() => runtimeSnapshot);

    expect(
      mod.isGatewayHealthCacheStale({
        ok: true,
        ts: Date.now(),
        durationMs: 1,
        channels: {
          whatsapp: {
            accountId: "default",
            configured: true,
            running: true,
          },
        },
        channelOrder: ["whatsapp"],
        channelLabels: { whatsapp: "WhatsApp" },
        heartbeatSeconds: 0,
        defaultAgentId: "main",
        agents: [],
        sessions: {
          path: "/tmp/sessions.json",
          count: 0,
          recent: [],
        },
      }),
    ).toBe(false);
  });
});
