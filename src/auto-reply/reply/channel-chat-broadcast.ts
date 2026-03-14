/**
 * Global Channel Chat Broadcast
 *
 * Singleton that holds the gateway's broadcast + nodeSendToSession
 * functions so that the auto-reply dispatch path can notify web UI
 * clients and paired node subscribers when external channel messages
 * (Telegram, WhatsApp, AnyGen, etc.) are processed.
 *
 * Normal chat events fan out through both websocket broadcast and
 * nodeSendToSession (see createAgentEventHandler in server-chat.ts).
 * This singleton mirrors that fan-out for synthetic channel events.
 *
 * Pattern follows src/plugins/hook-runner-global.ts.
 */

export type ChannelChatNotifyFn = (event: string, payload: unknown, sessionKey?: string) => void;

let globalNotify: ChannelChatNotifyFn | null = null;

/**
 * Register the gateway broadcast + node fan-out function.
 * Called once during gateway startup after the broadcaster and
 * node subscription manager are created.
 */
export function setGlobalChannelChatBroadcast(notify: ChannelChatNotifyFn): void {
  globalNotify = notify;
}

/**
 * Get the registered notify function.
 * Returns null if the gateway hasn't started yet.
 */
export function getGlobalChannelChatBroadcast(): ChannelChatNotifyFn | null {
  return globalNotify;
}

/**
 * Reset the global broadcast (for testing).
 */
export function resetGlobalChannelChatBroadcast(): void {
  globalNotify = null;
}
