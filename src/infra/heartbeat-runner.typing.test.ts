import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { bindHeartbeatReply } from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

const TELEGRAM_TARGET = "-1001234567890";

async function setup(
  { tmpDir, storePath, replySpy }: Parameters<Parameters<typeof withTempHeartbeatSandbox>[0]>[0],
  agents?: OpenClawConfig["agents"],
  channelHeartbeatVisibility?: Record<string, unknown>,
) {
  const sendTyping = vi.fn(async () => undefined);
  const clearTyping = vi.fn(async () => undefined);
  const plugin = {
    ...createOutboundTestPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "telegram", messageId: "m1" }),
      },
    }),
    heartbeat: { sendTyping, clearTyping },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
  const cfg: OpenClawConfig = {
    agents: {
      ...agents,
      defaults: {
        workspace: tmpDir,
        heartbeat: { every: "5m", target: "telegram" },
        ...agents?.defaults,
      },
    },
    channels: { telegram: { allowFrom: ["*"], heartbeatVisibility: channelHeartbeatVisibility } },
    session: { store: storePath },
  };
  await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: TELEGRAM_TARGET,
  });
  replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
  bindHeartbeatReply(replySpy);
  return {
    cfg,
    sendTyping,
    clearTyping,
    replySpy,
    run: () =>
      runHeartbeatWithFakeIntervals({
        cfg,
      }),
  };
}

async function withTyping(
  check: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  agents?: OpenClawConfig["agents"],
  visibility?: Record<string, unknown>,
) {
  await withTempHeartbeatSandbox(async (sandbox) =>
    check(await setup(sandbox, agents, visibility)),
  );
}

function expectTypingCall(
  mock: ReturnType<typeof vi.fn>,
  expected: { cfg: OpenClawConfig; to: string },
) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("missing typing call");
  }
  const [params] = call as [{ cfg?: unknown; to?: unknown }];
  expect(params.cfg).toBe(expected.cfg);
  expect(params.to).toBe(expected.to);
}

async function runHeartbeatWithFakeIntervals(options: Parameters<typeof runHeartbeatOnce>[0]) {
  // Keep typing refreshes independent of storage and dispatch wall time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    return await runHeartbeatOnce(options);
  } finally {
    vi.useRealTimers();
  }
}

describe("runHeartbeatOnce heartbeat typing", () => {
  it.each([
    { name: "default", seconds: 6, agents: undefined },
    { name: "configured", seconds: 2, agents: { defaults: { typingIntervalSeconds: 2 } } },
  ])(
    "keeps the $name typing cadence during a heartbeat and clears it once",
    async ({ seconds, agents }) => {
      await withTyping(async ({ cfg, sendTyping, clearTyping, replySpy, run }) => {
        const typingCounts: Array<{ sent: number; cleared: number }> = [];
        const recordTypingCounts = () =>
          typingCounts.push({
            sent: sendTyping.mock.calls.length,
            cleared: clearTyping.mock.calls.length,
          });
        replySpy.mockImplementation(async () => {
          recordTypingCounts();
          await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
          recordTypingCounts();
          await vi.advanceTimersByTimeAsync(1);
          recordTypingCounts();
          return { text: "HEARTBEAT_OK" };
        });

        expect((await run()).status).toBe("ran");
        recordTypingCounts();

        // Initial start, just before/at the keepalive deadline, and after the run.
        expect(typingCounts).toEqual([
          { sent: 1, cleared: 0 },
          { sent: 1, cleared: 0 },
          { sent: 2, cleared: 0 },
          { sent: 2, cleared: 1 },
        ]);
        expectTypingCall(sendTyping, { cfg, to: TELEGRAM_TARGET });
        expectTypingCall(clearTyping, { cfg, to: TELEGRAM_TARGET });
      }, agents);
    },
  );

  it.each([
    {
      name: "per-agent typingMode overrides the default",
      agents: { defaults: { typingMode: "instant" }, entries: { main: { typingMode: "never" } } },
    },
    {
      name: "chat heartbeat delivery is disabled",
      visibility: { showAlerts: false, showOk: false, useIndicator: true },
    },
  ] satisfies Array<{
    name: string;
    agents?: OpenClawConfig["agents"];
    visibility?: Record<string, unknown>;
  }>)("does not type when $name", async ({ agents, visibility }) => {
    await withTyping(
      async ({ sendTyping, run }) => {
        await run();
        expect(sendTyping).not.toHaveBeenCalled();
      },
      agents,
      visibility,
    );
  });
});
