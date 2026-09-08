import { vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../../gateway/server-methods/types.js";

export function makeGatewayContext(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    chatAbortedRuns: new Map(),
    clearChatRunState: vi.fn(),
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    getRuntimeConfig,
  } as unknown as GatewayRequestContext;
}

export function externalCliClient(): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "cli",
        version: "test",
        platform: "test",
        mode: "cli",
      },
      scopes: ["operator.write"],
    },
  } as GatewayRequestOptions["client"];
}

export async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  let lastError: unknown;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 10) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw lastError;
}
