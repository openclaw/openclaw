import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { createTestChannelManager } from "../server-channels.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { webHandlers } from "./web.js";

const ACCOUNTS = ["account-a", "account-b"];
afterEach(resetPluginRuntimeStateForTest);

it.each([true, false])(
  "keeps account A running while account B pairs (connected=%s)",
  async (connected) => {
    const live = new Set<string>();
    const starts = new Map(ACCOUNTS.map((id) => [id, createDeferredCore()]));
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "whatsapp",
        config: {
          listAccountIds: () => ACCOUNTS,
          resolveAccount: () => ({ enabled: true }),
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
          expect(accountId).toBe("account-b");
          return { message: "scan", qrDataUrl: "data:image/png;base64,QQ==" };
        },
        loginWithQrWait: async ({ accountId }) => {
          expect(accountId).toBe("account-b");
          return { connected, message: connected ? "linked" : "pairing timed out" };
        },
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.channels.push({ pluginId: plugin.id, source: "test", plugin });
    setActivePluginRegistry(registry);
    const cfg = { channels: { whatsapp: { enabled: true } } };
    const manager = createTestChannelManager({
      getRuntimeConfig: () => cfg,
      channelIds: ["whatsapp"],
    });
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      isConfigReloadSettled: () => true,
      stopChannel: (channel, accountId) =>
        manager.stopChannel(channel, accountId, { manual: true }),
      startChannel: (channel, accountId) => manager.startChannel(channel, accountId),
      getRuntimeSnapshot: () => manager.getRuntimeSnapshot(),
    });
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
    } finally {
      await manager.stopChannel("whatsapp");
    }
  },
);
