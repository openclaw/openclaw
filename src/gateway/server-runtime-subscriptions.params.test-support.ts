import { vi } from "vitest";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

export function createSubscriptionTestParams(
  log: SubsystemLogger,
): Parameters<typeof startGatewayEventSubscriptions>[0] {
  const chatRunState = createChatRunState();
  return {
    scheduler: createTestGatewayScheduler(),
    signal: new AbortController().signal,
    log,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    restartRecoveryCandidates: new Map(),
    refreshConnectedUserProfiles: vi.fn(),
  };
}
