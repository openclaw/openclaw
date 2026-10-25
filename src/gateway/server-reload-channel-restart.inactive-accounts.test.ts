import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputString } from "../config/types.secrets.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  waitForAbort,
} from "./server-channels.test-support.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

it.each([
  { name: "disabled idle", initiallyRunning: false, disabled: true },
  { name: "newly disabled running", initiallyRunning: true, disabled: true },
  { name: "enabled unresolved", initiallyRunning: false, disabled: false },
])(
  "preserves lifecycle and credential policy for a $name account",
  async ({ initiallyRunning, disabled }) => {
    const unresolvedRef = { source: "file", provider: "local", id: "/audit-token" } as const;
    const accountConfig = (enabled: boolean, resolved = false): OpenClawConfig => {
      const accounts = {
        default: { botToken: "test-default-token" },
        audit: { enabled, botToken: resolved ? "test-audit-token" : unresolvedRef },
      };
      return { channels: { telegram: { accounts } } };
    };
    let config = accountConfig(initiallyRunning, initiallyRunning);
    const [firstStart, restarted] = [createDeferred(), createDeferred()] as const;
    const started: string[] = [];
    const stopped: string[] = [];
    const registry = createTestChannelRegistry(
      createTestPlugin({
        id: "telegram",
        listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
        resolveAccount: (cfg, accountId) => {
          const resolvedId = accountId ?? "default";
          const account = cfg.channels?.telegram?.accounts?.[resolvedId];
          resolveSecretInputString({
            value: account?.botToken,
            path: `channels.telegram.accounts.${resolvedId}.botToken`,
          });
          return { enabled: account?.enabled !== false, configured: true };
        },
        startAccount: async ({ accountId, abortSignal }) => {
          started.push(accountId);
          if (accountId === "default") {
            const signal =
              started.filter((id) => id === "default").length === 1 ? firstStart : restarted;
            signal.resolve();
          }
          await waitForAbort(abortSignal);
        },
        stopAccount: async ({ accountId }) => {
          stopped.push(accountId);
        },
      }),
    );
    const manager = createTestChannelManager({
      channelIds: ["telegram"],
      getRuntimeConfig: () => config,
      getPluginRegistry: () => registry,
    });
    const scheduleRecoveryRestart = vi.fn();
    const logChannels = createInfoWarnErrorLogger();
    try {
      await manager.startChannels();
      await firstStart.promise;
      config = accountConfig(!disabled);
      await restartGatewayChannels({
        params: { ...manager, getPluginRegistry: () => registry, logChannels },
        nextConfig: config,
        channelsToRestart: new Set(["telegram"]),
        restartChannelAccounts: new Map(),
        activePluginChannelsAfterReload: null,
        shouldSkipChannelRestart: false,
        isLifecycleReloadAborted: () => false,
        getChannelAutostartSuppression: manager.getAutostartSuppression,
        scheduleRecoveryRestart,
      });
      if (disabled) {
        expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
        expect(logChannels.error).not.toHaveBeenCalled();
        await restarted.promise;
        expect(started.filter((id) => id === "default")).toHaveLength(2);
      } else {
        expect(scheduleRecoveryRestart).toHaveBeenCalledWith("channel restart (telegram)");
        expect(logChannels.error).toHaveBeenCalledWith(
          expect.stringContaining('unresolved SecretRef "file:local:/audit-token"'),
        );
      }
      expect(stopped.toSorted()).toEqual(initiallyRunning ? ["audit", "default"] : ["default"]);
    } finally {
      config = { channels: { telegram: { enabled: false } } };
      await manager.stopChannel("telegram");
    }
  },
);
