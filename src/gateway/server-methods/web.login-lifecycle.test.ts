/**
 * QR-login lifecycle scoping through the real channel manager.
 *
 * These cases drive the real `web.login.start`/`web.login.wait` handlers against a real
 * `createChannelManager`, so the stop/restore fan-out is observed on the lifecycle owner
 * rather than on a spy. Only the account listener is a stand-in for the channel transport.
 */
import { describe, expect, it } from "vitest";
import type { ChannelId, ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  requireActivePluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { webHandlers } from "./web.js";

const ACCOUNTS = ["arnold", "enzo", "valentina"];

function createQrLoginPlugin(params: {
  liveListeners: Set<string>;
  pluginAccountIds: Array<string | undefined>;
  connected: boolean;
}): ChannelPlugin {
  const describeAccount = (_cfg: unknown, accountId?: string) => ({
    accountId: accountId ?? ACCOUNTS[0],
    enabled: true,
    configured: true,
  });
  return {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "lifecycle test plugin",
      aliases: [],
    },
    capabilities: { chatTypes: ["direct"] },
    gatewayMethods: ["web.login.start", "web.login.wait"],
    config: {
      listAccountIds: () => ACCOUNTS,
      resolveAccount: describeAccount,
      isEnabled: () => true,
      describeAccount,
    },
    gateway: {
      // Stands in for the channel transport only: the listener stays alive until the
      // lifecycle owner aborts it, which is what a real account listener does.
      startAccount: async (ctx: { accountId: string; abortSignal: AbortSignal }) => {
        params.liveListeners.add(ctx.accountId);
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        params.liveListeners.delete(ctx.accountId);
      },
      loginWithQrStart: async (login: { accountId?: string }) => {
        params.pluginAccountIds.push(login.accountId);
        return { message: "scan the code", qrDataUrl: "data:image/png;base64,QQ==" };
      },
      loginWithQrWait: async (login: { accountId?: string }) => {
        params.pluginAccountIds.push(login.accountId);
        return {
          connected: params.connected,
          message: params.connected ? "linked" : "pairing timed out",
        };
      },
    },
  } as unknown as ChannelPlugin;
}

async function runAccountLessPairing(connected: boolean) {
  const { createChannelManager } = await import("../server-channels.js");
  const liveListeners = new Set<string>();
  const pluginAccountIds: Array<string | undefined> = [];
  const plugin = createQrLoginPlugin({ liveListeners, pluginAccountIds, connected });

  const registry = createEmptyPluginRegistry();
  registry.channels.push({ pluginId: plugin.id, source: "test", plugin });
  setActivePluginRegistry(registry);

  const log: SubsystemLogger = createSubsystemLogger("gateway/web-login-lifecycle-test");
  const cfg = { channels: { whatsapp: { enabled: true } } };
  const manager = createChannelManager({
    getRuntimeConfig: () => cfg as never,
    getPluginRegistry: requireActivePluginChannelRegistry,
    channelLogs: { whatsapp: log } as unknown as Record<ChannelId, SubsystemLogger>,
    channelRuntimeEnvs: { whatsapp: runtimeForLogger(log) } as unknown as Record<
      ChannelId,
      RuntimeEnv
    >,
  });

  const options = (method: "web.login.start" | "web.login.wait") =>
    ({
      req: { type: "req", id: "req-1", method, params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: () => {},
      context: {
        stopChannel: (channel: ChannelId, accountId?: string) =>
          manager.stopChannel(channel, accountId, { manual: true }),
        startChannel: (channel: ChannelId, accountId?: string) =>
          manager.startChannel(channel, accountId),
        getRuntimeSnapshot: () => manager.getRuntimeSnapshot(),
        getRuntimeConfig: () => cfg,
      },
    }) as unknown as GatewayRequestHandlerOptions;

  const settle = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
  const live = () => [...liveListeners].toSorted();

  await manager.startChannel("whatsapp" as ChannelId);
  await settle();
  const afterStartup = live();

  await webHandlers["web.login.start"]?.(options("web.login.start"));
  await settle();
  const duringPairing = live();

  await webHandlers["web.login.wait"]?.(options("web.login.wait"));
  await settle();
  const afterPairing = live();

  await manager.stopChannel("whatsapp" as ChannelId);
  return { afterStartup, duringPairing, afterPairing, pluginAccountIds };
}

describe("web QR login lifecycle scoping", () => {
  it("pairs one account and restores it without disturbing its siblings", async () => {
    const observed = await runAccountLessPairing(true);

    expect(observed.afterStartup).toEqual(ACCOUNTS);
    // Only the account being linked leaves the air while its QR code is outstanding.
    expect(observed.duringPairing).toEqual(["enzo", "valentina"]);
    // The linked account comes back once pairing completes.
    expect(observed.afterPairing).toEqual(ACCOUNTS);
    // The plugin still resolves the omitted account itself: account ids and credential
    // profiles are different namespaces.
    expect(observed.pluginAccountIds).toEqual([undefined, undefined]);
  });

  it("leaves the siblings running when pairing never completes", async () => {
    const observed = await runAccountLessPairing(false);

    expect(observed.afterStartup).toEqual(ACCOUNTS);
    expect(observed.duringPairing).toEqual(["enzo", "valentina"]);
    // An abandoned pairing must not take the rest of the channel down with it.
    expect(observed.afterPairing).toEqual(["enzo", "valentina"]);
  });
});
