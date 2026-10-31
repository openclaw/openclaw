import { readFile } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { applyLegacyDoctorMigrations } from "../commands/doctor/shared/legacy-config-compat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { channelReadyPatch } from "./channel-status-patches.js";
import type { ChannelManager } from "./server-channels.js";
import { createTestChannelManager, waitForAbort } from "./server-channels.test-support.js";

async function start(cfg: OpenClawConfig) {
  const state = await createOpenClawTestState({ label: "channel-ownership" });
  const previousRegistry = getActivePluginRegistry();
  const registry = createEmptyPluginRegistry();
  let manager: ChannelManager | undefined;
  onTestFinished(async () => {
    await manager?.stopChannel("discord");
    manager = undefined;
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
    await state.cleanup();
  });
  const started = vi.fn<(accountId: string, ownerAgentId: string) => void>();
  const startAccount = vi.fn(async (ctx: ChannelGatewayContext) => {
    const route = resolveAgentRoute({ cfg: ctx.cfg, channel: "discord", accountId: ctx.accountId });
    started(ctx.accountId, route.agentId);
    ctx.setStatus(channelReadyPatch({ accountId: ctx.accountId }));
    await waitForAbort(ctx.abortSignal);
  });
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: createAccountListHelpers("discord").listAccountIds,
        isConfigured: () => true,
      },
    }),
    gateway: { startAccount },
  };
  registry.channels.push({ pluginId: plugin.id, source: "test", plugin });
  setActivePluginRegistry(registry);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await state.writeConfig(cfg);
  // A restarted Gateway reads persisted config without the migration's in-memory owner.
  const runtimeConfig = JSON.parse(await readFile(state.configPath, "utf8")) as OpenClawConfig;
  manager = createTestChannelManager({
    getRuntimeConfig: () => runtimeConfig,
    getPluginRegistry: () => registry,
  });
  await manager.startChannels();
  await vi.advanceTimersByTimeAsync(0);
  return { manager, started, startAccount };
}

it("blocks an unowned account without retrying while its bound sibling stays online", async () => {
  const { manager, started, startAccount } = await start({
    agents: { ownership: "explicit", entries: { main: {}, patricia: {} } },
    channels: { discord: { enabled: true, accounts: { default: {}, patricia: {} } } },
    bindings: [{ agentId: "patricia", match: { channel: "discord", accountId: "patricia" } }],
  });
  const healthMonitor = startChannelHealthMonitor({
    scheduler: createTestGatewayScheduler("fake-timers"),
    channelManager: manager,
  });
  try {
    await vi.advanceTimersByTimeAsync(18 * 60_000);
    const accounts = manager.getRuntimeSnapshot().channelAccounts.discord;
    expect(startAccount, JSON.stringify(accounts)).toHaveBeenCalledTimes(2);
    expect(accounts).toMatchObject({
      default: {
        running: false,
        lifecycle: "blocked",
        terminalDisconnect: true,
        restartPending: false,
        reconnectAttempts: 0,
        lastError: expect.stringContaining("discord account default routing has no explicit owner"),
      },
      patricia: { running: true, connected: true, lifecycle: "ready" },
    });
    expect(accounts?.default?.lastError).toContain(
      '{"agentId":"<agentId>","match":{"channel":"discord","accountId":"default"}}',
    );
    expect(accounts?.default?.lastError).toContain("then restart the Gateway");
    expect(manager.isAutoRestartScheduled("discord", "default")).toBe(false);
    expect(started).toHaveBeenCalledExactlyOnceWith("patricia", "patricia");
  } finally {
    healthMonitor.stop();
    await healthMonitor.waitForIdle();
  }
});

it.each([
  { authored: "Ops", owner: "ops", sibling: "main" },
  { authored: "main", owner: "main", sibling: "patricia" },
])(
  "preserves legacy account owner $authored across migration and a persisted restart",
  async ({ authored, owner, sibling }) => {
    const raw = {
      agents: { list: [{ id: authored }, { id: sibling }] },
      channels: { discord: { enabled: true } },
    };
    const repaired = applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
    const { manager, started } = await start(repaired.next as OpenClawConfig);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.default).toMatchObject({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastError: null,
    });
    expect(started).toHaveBeenCalledExactlyOnceWith("default", owner);
    expect(repaired.next?.bindings).toContainEqual({
      agentId: owner,
      match: { channel: "discord", accountId: "default" },
    });
  },
);
