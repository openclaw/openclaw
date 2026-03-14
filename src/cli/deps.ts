import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

/**
 * Lazy-loaded per-channel send functions, keyed by channel ID.
 * Values are proxy functions that dynamically import the real module on first use.
 */
export type CliDeps = { [channelId: string]: unknown };

// Per-channel module caches for lazy loading.
const senderCache = new Map<string, Promise<Record<string, unknown>>>();

/**
 * Create a lazy-loading send function proxy for a channel.
 * The channel's module is loaded on first call and cached for reuse.
 */
function createLazySender(
  channelId: string,
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    let cached = senderCache.get(channelId);
    if (!cached) {
      cached = loader();
      senderCache.set(channelId, cached);
    }
    const mod = await cached;
    const fn = mod[exportName] as (...a: unknown[]) => Promise<unknown>;
    return await fn(...args);
  };
}

export function createDefaultDeps(): CliDeps {
  return {
    whatsapp: createLazySender(
      "whatsapp",
      () => import("../channels/web/index.js") as Promise<Record<string, unknown>>,
      "sendMessageWhatsApp",
    ),
    telegram: createLazySender(
      "telegram",
      () => import("../telegram/send.js") as Promise<Record<string, unknown>>,
      "sendMessageTelegram",
    ),
    discord: createLazySender(
      "discord",
      () => import("../discord/send.js") as Promise<Record<string, unknown>>,
      "sendMessageDiscord",
    ),
    slack: createLazySender(
      "slack",
      () => import("../slack/send.js") as Promise<Record<string, unknown>>,
      "sendMessageSlack",
    ),
    signal: createLazySender(
      "signal",
      () => import("../signal/send.js") as Promise<Record<string, unknown>>,
      "sendMessageSignal",
    ),
    imessage: createLazySender(
      "imessage",
      () => import("../imessage/send.js") as Promise<Record<string, unknown>>,
      "sendMessageIMessage",
    ),
  };
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}

export { logWebSelfId } from "../web/auth-store.js";
