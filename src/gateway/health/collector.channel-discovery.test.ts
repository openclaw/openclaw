import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as persistedAuth from "../../channels/plugins/persisted-auth-state.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as configRuntime from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { collectGatewayHealthSnapshot } from "./collector.js";

let state: OpenClawTestState | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  clearPluginMetadataLifecycleCaches();
  await state?.cleanup();
  state = undefined;
});

describe("Gateway health channel discovery", () => {
  it.each(["public", "admin"] as const)(
    "includes admitted accounts without operational hooks in %s health",
    async (audience) => {
      state = await createOpenClawTestState({ label: "health-admitted-accounts" });
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        bindings: [{ agentId: "main", match: { channel: "admitted-chat", accountId: "bound" } }],
      };
      vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue(config);
      const resolveAccount = vi.fn((_cfg: OpenClawConfig, accountId?: string | null) => {
        if (accountId !== "primary" && accountId !== "bound") {
          throw new Error("admitted account has no current operational configuration");
        }
        return { accountId, enabled: true, configured: true };
      });
      const inspectAccount = vi.fn(resolveAccount);
      const probeAccount = vi.fn(async () => ({ ok: true, credential: "private-live-probe" }));
      const buildChannelSummary = vi.fn(({ account }: { account: { accountId: string } }) => ({
        name: `Resolved ${account.accountId}`,
      }));
      const plugin: ChannelPlugin<ReturnType<typeof resolveAccount>> = {
        ...createChannelTestPluginBase({ id: "admitted-chat" }),
        config: {
          listAccountIds: () => ["primary"],
          resolveAccount,
          inspectAccount,
          isEnabled: (account) => account.enabled,
          isConfigured: (account) => account.configured,
        },
        status: { probeAccount, buildChannelSummary },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "admitted-owner", plugin, source: "fixture" }]),
      );
      const baseUrl = new URL("https://chat.example.test/?token=runtime-token");
      baseUrl.username = "runtime-user";
      baseUrl.password = "runtime-password";
      const audienceUrl = new URL("https://audience.example.test/?token=audience-token");
      audienceUrl.username = "audience-user";
      audienceUrl.password = "audience-password";
      const recovered: ChannelAccountSnapshot = {
        accountId: "recovered",
        enabled: true,
        configured: true,
        running: true,
        lifecycle: "starting",
        stateReason: "admitted before configuration changed",
        lastStartAt: 1200,
        tokenSource: "config",
        tokenStatus: "available",
        baseUrl: baseUrl.href,
        audience: audienceUrl.href,
        channelSecret: "private-channel-secret",
        channelAccessToken: "private-channel-token",
        webhookUrl: "https://private-webhook.example.test/secret",
        publicKey: "private-provider-key",
        probe: { credential: "private-runtime-probe" },
        audit: { credential: "private-runtime-audit" },
        application: { credential: "private-application" },
        bot: { credential: "private-bot" },
        profile: { credential: "private-profile" },
      };
      const snapshot = await collectGatewayHealthSnapshot({
        audience,
        probe: true,
        runtimeSnapshot: {
          channels: { "admitted-chat": { accountId: "primary", running: false } },
          channelAccounts: {
            "admitted-chat": {
              recovered,
              retrying: {
                accountId: "retrying",
                enabled: true,
                configured: true,
                running: false,
                connected: false,
                lifecycle: "recovering",
                restartPending: true,
                reconnectAttempts: 4,
                terminalDisconnect: false,
                lastStopAt: 2300,
                lastError: "waiting for restart",
              },
              terminal: {
                accountId: "terminal",
                enabled: true,
                configured: true,
                running: false,
                lifecycle: "blocked",
                terminalDisconnect: true,
                lastError: "account requires login",
              },
            },
          },
        },
      });

      const channel = expectDefined(snapshot.channels["admitted-chat"], "admitted channel health");
      expect(channel).toMatchObject({ accountId: "bound", name: "Resolved bound" });
      const accounts = expectDefined(channel.accounts, "admitted account health records");
      expect(Object.keys(accounts).toSorted()).toEqual([
        "bound",
        "primary",
        "recovered",
        "retrying",
        "terminal",
      ]);
      expect(accounts.primary).toMatchObject({
        accountId: "primary",
        configured: true,
        running: false,
        name: "Resolved primary",
      });
      const admitted = expectDefined(accounts.recovered, "admitted runtime health");
      expect(admitted).toMatchObject({
        accountId: "recovered",
        enabled: true,
        configured: true,
        running: true,
        lifecycle: "starting",
        stateReason: "admitted before configuration changed",
        lastStartAt: 1200,
        tokenSource: "config",
        tokenStatus: "available",
        baseUrl: "https://chat.example.test/?token=***",
        audience: "https://audience.example.test/?token=***",
      });
      expect(admitted.connected).toBeUndefined();
      for (const field of [
        "channelSecret",
        "channelAccessToken",
        "webhookUrl",
        "publicKey",
        "probe",
        "audit",
        "application",
        "bot",
        "profile",
      ]) {
        expect(admitted[field], field).toBeUndefined();
      }
      expect(accounts.retrying).toMatchObject({
        configured: true,
        running: false,
        connected: false,
        lifecycle: "recovering",
        restartPending: true,
        reconnectAttempts: 4,
        terminalDisconnect: false,
        lastStopAt: 2300,
        lastError: "waiting for restart",
      });
      expect(accounts.terminal).toMatchObject({
        running: false,
        lifecycle: "blocked",
        terminalDisconnect: true,
        healthState: "terminal-disconnect",
        lastError: "account requires login",
      });
      expect(new Set(resolveAccount.mock.calls.map((call) => call[1]))).toEqual(
        new Set(["primary", "bound"]),
      );
      expect(new Set(inspectAccount.mock.calls.map((call) => call[1]))).toEqual(
        new Set(["primary", "bound"]),
      );
      expect(probeAccount).toHaveBeenCalledTimes(2);
      expect(buildChannelSummary).toHaveBeenCalledTimes(2);
      if (audience === "admin") {
        expect(accounts.primary?.probe).toEqual({ ok: true, credential: "private-live-probe" });
      } else {
        expect(accounts.primary?.probe).toBeUndefined();
        expect(JSON.stringify(snapshot)).not.toContain("private-live-probe");
      }
    },
  );

  it.each(["missing", "empty"] as const)(
    "uses admitted channels and configured failures without credential discovery (%s runtime snapshot)",
    async (runtime) => {
      state = await createOpenClawTestState({ label: "health-channel-discovery" });
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
        channels: {
          "failed-chat": {
            accounts: { default: { enabled: true }, disabled: { enabled: false } },
          },
        },
      };
      vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue(config);
      setGatewayPluginMetadataSnapshot(
        createPluginMetadataSnapshot({
          config,
          manifestRegistry: makeRegistry([
            {
              id: "failed-owner",
              origin: "bundled",
              channels: ["failed-chat"],
              channelConfigs: { "failed-chat": { schema: { type: "object" } } },
            },
          ]),
        }),
        { config },
      );
      const account = { accountId: "default", enabled: true, configured: true, linked: true };
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const registered = createChannelTestPluginBase({
        id: "linked-chat",
        config: { resolveAccount: () => account, inspectAccount: () => account },
      });
      const registry = createTestRegistry([
        {
          pluginId: "linked-owner",
          plugin: { ...registered, status: { probeAccount } },
          source: "fixture",
        },
      ]);
      registry.plugins.push(
        createPluginRecord({
          id: "failed-owner",
          enabled: true,
          activated: true,
          status: "error",
          failurePhase: "load",
          channelIds: ["failed-chat"],
          error: "fixture channel runtime failed to load",
        }),
      );
      setActivePluginRegistry(registry);

      // The real read-only resolver must not enter this synchronous cold-loader boundary.
      vi.spyOn(persistedAuth, "listBundledChannelIdsWithPersistedAuthState").mockReturnValue([
        "dormant-chat",
      ]);
      const checkPersistedAuth = vi
        .spyOn(persistedAuth, "hasBundledChannelPersistedAuthState")
        .mockImplementation(() => {
          throw new Error("health attempted dormant credential discovery");
        });
      const snapshot = await collectGatewayHealthSnapshot({
        audience: "admin",
        probe: true,
        ...(runtime === "empty" ? { runtimeSnapshot: { channels: {}, channelAccounts: {} } } : {}),
      });

      expect(checkPersistedAuth).not.toHaveBeenCalled();
      expect(snapshot.channelOrder.toSorted()).toEqual(["failed-chat", "linked-chat"]);
      expect(snapshot.channels["linked-chat"]).toMatchObject({
        configured: true,
        linked: true,
        probe: { ok: true },
      });
      expect(probeAccount).toHaveBeenCalledOnce();
      expect(snapshot.channels["failed-chat"]?.accounts).toMatchObject({
        default: { enabled: true, configured: true, running: false, lifecycle: "blocked" },
        disabled: { enabled: false, configured: true, running: false, lifecycle: "blocked" },
      });
      expect(snapshot.plugins?.errors).toEqual([
        expect.objectContaining({
          id: "failed-owner",
          error: expect.stringContaining("failed to load"),
        }),
      ]);
    },
  );
});
