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
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { webHandlers } from "./web.js";

// The default account: an account-less login pairs this one.
const PAIRED_ACCOUNT = "arnold";
const ACCOUNTS = [PAIRED_ACCOUNT, "enzo", "valentina"];

type ListenerTransition = "started" | "stopped";

/** Live account listeners plus one-shot signals for their next start or stop. */
function createListenerLog() {
  const live = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  const signal = (transition: ListenerTransition, accountId: string) => {
    const key = `${transition}:${accountId}`;
    const pending = waiters.get(key) ?? [];
    waiters.delete(key);
    for (const resolve of pending) {
      resolve();
    }
  };
  return {
    live: () => [...live].toSorted(),
    started(accountId: string) {
      live.add(accountId);
      signal("started", accountId);
    },
    stopped(accountId: string) {
      live.delete(accountId);
      signal("stopped", accountId);
    },
    // Register before triggering the transition: the listener may settle in the same tick.
    next(transition: ListenerTransition, accountId: string): Promise<void> {
      return new Promise((resolve) => {
        const key = `${transition}:${accountId}`;
        waiters.set(key, [...(waiters.get(key) ?? []), resolve]);
      });
    },
  };
}

type ListenerLog = ReturnType<typeof createListenerLog>;

function createQrLoginPlugin(params: {
  listeners: ListenerLog;
  pluginAccountIds: Array<string | undefined>;
  connected: boolean;
}): ChannelPlugin {
  const describeAccount = (_cfg: unknown, accountId?: string) => ({
    accountId: accountId ?? PAIRED_ACCOUNT,
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
        params.listeners.started(ctx.accountId);
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        params.listeners.stopped(ctx.accountId);
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
  const listeners = createListenerLog();
  const pluginAccountIds: Array<string | undefined> = [];
  const plugin = createQrLoginPlugin({ listeners, pluginAccountIds, connected });

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
    scheduler: createTestGatewayScheduler(),
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

  const startup = Promise.all(ACCOUNTS.map((id) => listeners.next("started", id)));
  await manager.startChannel("whatsapp" as ChannelId);
  await startup;
  const afterStartup = listeners.live();

  // The handler awaits the stop, and the stop awaits the listener's exit.
  const paused = listeners.next("stopped", PAIRED_ACCOUNT);
  await webHandlers["web.login.start"]?.(options("web.login.start"));
  await paused;
  const duringPairing = listeners.live();

  const restored = listeners.next("started", PAIRED_ACCOUNT);
  await webHandlers["web.login.wait"]?.(options("web.login.wait"));
  if (connected) {
    await restored;
  }
  const afterPairing = listeners.live();

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
