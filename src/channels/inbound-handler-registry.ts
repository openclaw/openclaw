/**
 * Global registry for tracking active inbound message handlers.
 * Used to ensure gateway restart waits for all message processing to complete,
 * including command execution AND reply delivery.
 *
 * This solves the race condition where commands complete before replies are sent.
 */

export type InboundHandlerInfo = {
  channel: string;
  handlerId: string;
  startedAt: number;
};

const activeHandlers = new Map<string, InboundHandlerInfo>();

/**
 * Register an active inbound message handler.
 * Call the returned unregister function when message processing is COMPLETELY done,
 * including all reply delivery.
 *
 * @example
 * async function handleMessage(msg) {
 *   const { unregister } = registerInboundHandler({
 *     channel: 'imessage',
 *     handlerId: `${accountId}:${msg.id}`,
 *   });
 *   try {
 *     // Process message, execute commands, send replies
 *     await dispatcher.waitForIdle();
 *   } finally {
 *     unregister(); // ALWAYS call in finally block
 *   }
 * }
 */
export function registerInboundHandler(info: { channel: string; handlerId: string }): {
  id: string;
  unregister: () => void;
} {
  const id = `${info.channel}:${info.handlerId}`;
  const handlerInfo: InboundHandlerInfo = {
    channel: info.channel,
    handlerId: info.handlerId,
    startedAt: Date.now(),
  };

  activeHandlers.set(id, handlerInfo);

  const unregister = () => {
    activeHandlers.delete(id);
  };

  return { id, unregister };
}

/**
 * Check if any inbound message handlers are currently active.
 */
export function hasActiveInboundHandlers(): boolean {
  return activeHandlers.size > 0;
}

/**
 * Get the count of active inbound message handlers.
 */
export function getActiveInboundHandlerCount(): number {
  return activeHandlers.size;
}

/**
 * Get details of all active handlers (for diagnostics/logging).
 */
export function getActiveInboundHandlers(): InboundHandlerInfo[] {
  return Array.from(activeHandlers.values());
}

/**
 * Get a summary of active handlers by channel.
 */
export function getActiveHandlersByChannel(): Record<string, number> {
  const byChannel: Record<string, number> = {};
  for (const handler of activeHandlers.values()) {
    byChannel[handler.channel] = (byChannel[handler.channel] || 0) + 1;
  }
  return byChannel;
}

/**
 * Clear all registered handlers (for testing).
 * WARNING: Only use this in test cleanup!
 */
export function clearAllHandlers(): void {
  activeHandlers.clear();
}
