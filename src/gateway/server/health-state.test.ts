import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { HealthSummary } from "../../commands/health.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { installGatewayTestHooks, setTestPluginRegistry, testState } from "../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let healthStateModule: typeof import("./health-state.js");

const createSlackHealthPlugin = (): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: "slack",
    label: "Slack",
    config: {
      resolveAccount: () => ({
        botToken: "xoxb-test",
        appToken: "xapp-test",
      }),
      isConfigured: async () => true,
    },
  }),
  status: {
    buildAccountSnapshot: async ({ runtime }) => ({
      accountId: "default",
      configured: true,
      botTokenSource: "config",
      appTokenSource: "config",
      running: runtime?.running === true,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
    buildChannelSummary: async () => ({
      accountId: "default",
      configured: true,
      botTokenSource: "none",
      appTokenSource: "none",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    }),
  },
});

const buildBaseHealthSummary = (): HealthSummary => ({
  ok: true,
  ts: 1,
  durationMs: 5,
  channels: {
    slack: {
      accountId: "default",
      configured: true,
      botTokenSource: "none",
      appTokenSource: "none",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      accounts: {
        default: {
          accountId: "default",
          configured: true,
          botTokenSource: "none",
          appTokenSource: "none",
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
      },
    },
  },
  channelOrder: ["slack"],
  channelLabels: { slack: "Slack" },
  heartbeatSeconds: 0,
  defaultAgentId: "main",
  agents: [],
  sessions: {
    path: "/tmp/test-sessions.json",
    count: 0,
    recent: [],
  },
});

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(async () => {
    vi.resetModules();
    healthStateModule = await import("./health-state.js");
    testState.channelsConfig = {
      slack: {
        enabled: true,
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    };
    setTestPluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: createSlackHealthPlugin(),
        },
      ]),
    );
    healthStateModule.setHealthRuntimeSnapshotProvider(() => ({
      channels: {
        slack: {
          accountId: "default",
          enabled: true,
          configured: true,
          running: true,
          lastStartAt: 1_777_000_000_000,
          lastStopAt: null,
          lastError: null,
        },
      },
      channelAccounts: {
        slack: {
          default: {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            lastStartAt: 1_777_000_000_000,
            lastStopAt: null,
            lastError: null,
          },
        },
      },
    }));
  });

  test("merges live runtime channel state into health snapshots", async () => {
    const input = buildBaseHealthSummary();
    input.channels.slack.configured = false;
    const snap = await healthStateModule.overlayHealthSnapshotWithRuntime(input);

    expect(snap.channels.slack.botTokenSource).toBe("config");
    expect(snap.channels.slack.appTokenSource).toBe("config");
    expect(snap.channels.slack.running).toBe(true);
    expect(snap.channels.slack.lastStartAt).toBe(1_777_000_000_000);
    expect(snap.channels.slack.configured).toBe(false);
    expect(snap.channels.slack.accounts?.default?.running).toBe(true);
    expect(snap.channels.slack.accounts?.default?.botTokenSource).toBe("config");
    expect(healthStateModule.getHealthCache()).toBeNull();
  });
});
