import type { WebInboundMessage } from "./inbound.js";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
} from "./auto-reply.test-harness.js";

export async function monitorWebChannelWithCapture(resolver: unknown): Promise<{
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
}> {
  const spies = createWebInboundDeliverySpies();
  const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();

  await monitorWebChannel(false, listenerFactory, false, resolver as never);
  const onMessage = getOnMessage();
  if (!onMessage) {
    throw new Error("Missing onMessage handler");
  }

  return { spies, onMessage };
}
