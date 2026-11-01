// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import { expect, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import {
  createCtx,
  createDispatch,
  createRecordInboundSession,
} from "./run-channel-turn.delivery.test-helpers.js";
import type { AssembledChannelTurn } from "./types.js";

export const finalInfo = { kind: "final" } as const;
export const reply = { text: "reply" };
export const finalDispatch = () => ({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });

export function expectMessagesSent(
  ...events: [content: string, messageId: string | undefined, error?: string][]
) {
  expect(channelTurnMocks.emitMessageSent.mock.calls).toEqual(
    events.map(([content, messageId, error]) => [
      {
        success: error === undefined,
        content,
        messageId,
        ...(error === undefined ? {} : { error }),
      },
    ]),
  );
}

export function turnContext(storePath: string, channel = "test") {
  return {
    channel,
    storePath,
    routeSessionKey: `agent:main:${channel}:peer`,
    ctxPayload: createCtx(),
    recordInboundSession: createRecordInboundSession(),
  };
}

export function assembledTurn(
  storePath: string,
  overrides: Partial<AssembledChannelTurn> = {},
): AssembledChannelTurn {
  return {
    ...turnContext(storePath, overrides.channel),
    cfg: {},
    agentId: "main",
    dispatchReplyWithBufferedBlockDispatcher: createDispatch(),
    delivery: { deliver: vi.fn() },
    ...overrides,
  };
}

export function resetTurnState() {
  vi.clearAllMocks();
  outboundMessageIdentities.clear();
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info" });
  channelTurnMocks.createMessageSentEmitter.mockImplementation(() => ({
    emitMessageSent: channelTurnMocks.emitMessageSent,
    hasMessageSentHooks: true,
  }));
  channelTurnMocks.getGlobalHookRunner.mockReturnValue(null);
}

export function resetTurnLogger() {
  setLoggerOverride(null);
  resetLogger();
}
