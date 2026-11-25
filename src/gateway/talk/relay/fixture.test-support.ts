import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { relaySessions, type CreateTalkRealtimeRelaySessionParams } from "./state.js";

type RelayFixtureOptions = Partial<Omit<CreateTalkRealtimeRelaySessionParams, "sessionTarget">> & {
  key?: string;
};

export function useRelayFixtures() {
  const active = new Map<string, string>();
  usePersistentRelayTestState(active);
  return async ({
    cfg = {},
    connId = "conn-1",
    key = "agent:main:main",
    ...overrides
  }: RelayFixtureOptions = {}) => {
    const context = overrides.context ?? createGatewayRequestContext(makeContextParams());
    if (!overrides.context) {
      context.getRuntimeConfig = () => cfg;
    }
    const created = createTalkRealtimeRelaySession({
      cfg,
      connId,
      context,
      provider: createIdleRelayProvider(),
      providerConfig: {},
      instructions: "brief",
      tools: [],
      controlSource: "transcript",
      ...overrides,
      sessionTarget: await prepareTalkSessionTarget(cfg, key),
    });
    active.set(created.relaySessionId, connId);
    const relay = relaySessions.get(created.relaySessionId)!;
    return { relay, relaySessionId: relay.id };
  };
}
