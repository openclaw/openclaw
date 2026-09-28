import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressMonitor } from "../channels/message/ingress-monitor.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry, createPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";

describe("channel startup trust refusal", () => {
  let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
  let manager: ChannelManager | undefined;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    resetGatewayWorkAdmission();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(async () => {
    await manager?.stopChannel("discord");
    manager = undefined;
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("records a path plugin's wrapped trust refusal once without restarting its channel", async () => {
    const source = "/fixture/plugins-local/discord/index.js";
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: { state: {} } as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "discord",
      origin: "config",
      source,
      trust: {
        reason: "origin-path",
        registryPath: "/fixture/state/openclaw.sqlite",
        origin: "config",
        installSource: "path",
      },
    });
    const api = builder.createApi(record, { config: {} });
    const healthAtHandoff: Array<string | undefined> = [];
    const startAccount = vi.fn(async ({ abortSignal, getStatus }: ChannelGatewayContext) => {
      healthAtHandoff.push(getStatus().healthState);
      const monitor = createChannelIngressMonitor<string, string, string>({
        queue: () => api.runtime.state.openChannelIngressQueue<string>(),
        inspect: () => null,
        payload: {
          version: 1,
          storage: "raw-event",
          serialize: (raw) => raw,
          deserialize: (body) => body,
          createClaimError: () => new Error("invalid fixture event"),
        },
        deliver: async () => {},
        pollIntervalMs: 10,
        retention: "standard",
        abortSignal,
      });
      monitor.start();
    });
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          resolveAccount: () => ({ enabled: true, configured: true }),
          isConfigured: () => true,
          describeAccount: () => ({ accountId: "default", enabled: true, configured: true }),
        },
      }),
      gateway: { startAccount },
    };
    api.registerChannel({ plugin });
    builder.registry.plugins.push(record);
    setActivePluginRegistry(builder.registry);
    const log = createSubsystemLogger("gateway/channel-trust-refusal-test");
    manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      getPluginRegistry: () => builder.registry,
      channelLogs: { discord: log },
      channelRuntimeEnvs: { discord: runtimeForLogger(log) },
    });
    const healthMonitor = startChannelHealthMonitor({
      scheduler: createTestGatewayScheduler("fake-timers"),
      channelManager: manager,
      checkIntervalMs: 60_000,
      timing: { monitorStartupGraceMs: 50, channelConnectGraceMs: 0 },
    });
    try {
      await manager.startChannels();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(startAccount).toHaveBeenCalledTimes(1);
      await expect(startAccount.mock.results[0]?.value).rejects.toMatchObject({
        code: "CHANNEL_INGRESS_UNAVAILABLE",
        cause: { code: "PLUGIN_TRUST_REFUSED" },
      });
      const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
      expect(account).toMatchObject({
        running: false,
        lifecycle: "blocked",
        healthState: "plugin-trust-refused",
        terminalDisconnect: true,
        restartPending: false,
        reconnectAttempts: 0,
        lastError: expect.stringContaining(source),
      });
      expect(account?.lastError).toContain('installSource="path"');
      expect(account?.lastError).toContain("official npm package or ClawHub listing");
      expect(
        collectChannelStatusIssues({ channelAccounts: { discord: [account] } }, [plugin]),
      ).toContainEqual(expect.objectContaining({ message: account?.lastError }));
      expect(manager.isAutoRestartScheduled("discord", "default")).toBe(false);
      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(startAccount).toHaveBeenCalledTimes(2);
      expect(healthAtHandoff).toEqual([undefined, undefined]);
    } finally {
      healthMonitor.stop();
      await healthMonitor.waitForIdle();
    }
  });
});
