import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createSubsystemLogger, runtimeForLogger } from "../../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { webHandlers } from "./web.js";

const ACCOUNTS = ["account-a", "account-b"];
afterEach(resetPluginRuntimeStateForTest);

it.each([true, false])(
  "keeps account A running while account B pairs (connected=%s)",
  async (connected) => {
    const { createChannelManager } = await import("../server-channels.js");
    const live = new Set<string>();
    const starts = new Map(ACCOUNTS.map((id) => [id, createDeferredCore()]));
    const loginAccounts: Array<string | undefined> = [];
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "whatsapp",
        label: "WhatsApp",
        config: {
          listAccountIds: () => ACCOUNTS,
          resolveAccount: (_cfg, accountId) => ({
            accountId: accountId ?? "account-a",
            enabled: true,
          }),
        },
      }),
      gatewayMethods: ["web.login.start", "web.login.wait"],
      gateway: {
        startAccount: async ({ accountId, abortSignal }) => {
          live.add(accountId);
          starts.get(accountId)?.resolve();
          if (!abortSignal.aborted) {
            await once(abortSignal, "abort");
          }
          live.delete(accountId);
        },
        loginWithQrStart: async ({ accountId }) => {
          loginAccounts.push(accountId);
          return { message: "scan", qrDataUrl: "data:image/png;base64,QQ==" };
        },
        loginWithQrWait: async ({ accountId }) => {
          loginAccounts.push(accountId);
          return { connected, message: connected ? "linked" : "pairing timed out" };
        },
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.channels.push({ pluginId: plugin.id, source: "test", plugin });
    setActivePluginRegistry(registry);
    const cfg = { channels: { whatsapp: { enabled: true } } };
    const log = createSubsystemLogger("gateway/web-login-lifecycle-test");
    const manager = createChannelManager({
      getRuntimeConfig: () => cfg,
      getPluginRegistry: requireActivePluginChannelRegistry,
      channelLogs: { whatsapp: log },
      channelRuntimeEnvs: { whatsapp: runtimeForLogger(log) },
      scheduler: createTestGatewayScheduler(),
    });
    const context = createGatewayRequestContext(
      makeContextParams({
        stopChannel: (channel, accountId) =>
          manager.stopChannel(channel, accountId, { manual: true }),
        startChannel: (channel, accountId) => manager.startChannel(channel, accountId),
        getRuntimeSnapshot: () => manager.getRuntimeSnapshot(),
      }),
    );
    context.getRuntimeConfig = () => cfg;
    // Direct handler calls do not carry a request-scoped method registry.
    delete context.getGatewayMethodRegistry;
    const invoke = async (method: "web.login.start" | "web.login.wait") => {
      const params = { accountId: "account-b" };
      const respond = vi.fn();
      await expectDefined(
        webHandlers[method],
        "web login handler",
      )({
        req: { type: "req", id: method, method, params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond,
        context,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    };
    try {
      await manager.startChannel("whatsapp");
      await Promise.all([...starts.values()].map((started) => started.promise));
      expect([...live].toSorted()).toEqual(ACCOUNTS);
      await invoke("web.login.start");
      expect([...live]).toEqual(["account-a"]);
      const restored = createDeferredCore();
      starts.set("account-b", restored);
      await invoke("web.login.wait");
      if (connected) {
        await restored.promise;
      }
      expect([...live].toSorted()).toEqual(connected ? ACCOUNTS : ["account-a"]);
      expect(loginAccounts).toEqual(["account-b", "account-b"]);
    } finally {
      await manager.stopChannel("whatsapp");
    }
  },
);
