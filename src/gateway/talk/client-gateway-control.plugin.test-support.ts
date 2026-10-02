import { vi } from "vitest";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import type { GatewayControlOwner } from "./client-gateway-control.types.js";

export type TalkGatewayControlOwnerTestFixture = {
  closeLogicalSession: () => Promise<void>;
  events: Array<{ type: string; payload: unknown }>;
  owner: GatewayControlOwner;
  readLogicalSessionStatus: () => "open" | "closed" | undefined;
};

export function createTalkGatewayControlOwnerTestFixture(
  voiceSessionId: string,
): TalkGatewayControlOwnerTestFixture {
  const agentId = "main";
  const sessionKey = "agent:main:main";
  const events: Array<{ type: string; payload: unknown }> = [];
  createOrResumeClientVoiceSession({
    agentId,
    sessionKey,
    voiceSessionId,
    origin: "client",
  });
  const closeLogicalSession = vi.fn(async () => {
    await closeClientVoiceSession({
      agentId,
      sessionKey,
      voiceSessionId,
      config: {},
    });
  });
  const owner = createTalkClientGatewayControlOwner({
    voiceSessionId,
    sessionTarget: {
      agentId,
      sessionKey,
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions",
    },
    connId: `conn-${voiceSessionId}`,
    context: {
      logGateway: { warn: vi.fn() },
      chatAbortControllers: new Map(),
      broadcastToConnIds: vi.fn((_name: string, payload: { talkEvent?: unknown }) => {
        if (payload.talkEvent) {
          events.push(payload.talkEvent as { type: string; payload: unknown });
        }
      }),
    } as never,
    runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
    runAgentConsult: vi.fn(async () => ({ text: "done" })),
    appendTranscript: vi.fn(async () => undefined),
    flushTranscript: vi.fn(async () => undefined),
    closeLogicalSession,
  });
  owner.activate();
  return {
    closeLogicalSession,
    events,
    owner,
    readLogicalSessionStatus: () =>
      clientVoiceSessionTesting.readRecord(agentId, voiceSessionId)?.status,
  };
}
