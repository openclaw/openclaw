import { vi } from "vitest";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";

export function createSubscriptionTestFixture() {
  const warn = vi.fn();
  const log: SubsystemLogger = {
    subsystem: "gateway-test",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => log,
  };
  return {
    log,
    warn,
    createParams: (): Parameters<typeof startGatewayEventSubscriptions>[0] => {
      const chatRunState = createChatRunState();
      return {
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
        chatAbortControllers: new Map(),
        restartRecoveryCandidates: new Map(),
        terminalSessions: { closeTaskSessions: vi.fn() },
        refreshConnectedUserProfiles: vi.fn(),
      };
    },
  };
}

export function readLifecycleState(entry: ChatAbortControllerEntry) {
  return {
    projectSessionActive: entry.projectSessionActive,
    projectSessionTerminalPending: entry.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: entry.projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence: entry.projectSessionTerminalPersistence,
    projectSessionTerminalPersisted: entry.projectSessionTerminalPersisted,
    registrationCleanupRequested: entry.registrationCleanupRequested,
  };
}

export function lifecycleState(
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  registrationCleanupRequested?: boolean,
): ReturnType<typeof readLifecycleState> {
  return {
    projectSessionActive,
    projectSessionTerminalPending,
    projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence,
    projectSessionTerminalPersisted,
    registrationCleanupRequested,
  };
}
