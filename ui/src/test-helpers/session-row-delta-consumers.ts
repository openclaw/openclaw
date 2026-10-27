import type { GatewayEventFrame } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../lib/sessions/session-capability.test-support.ts";
import { createSessionActivity } from "../pages/activity/session-activity-owner.ts";
import { handlePageGatewayEvent } from "../pages/chat/chat-state-events.test-support.ts";
import { createSessionEventState } from "../pages/chat/chat-state.test-support.ts";
import { getChatSessionProjection } from "../pages/chat/history-merge.ts";
import { createTestGatewayClient } from "./gateway-client.ts";

/** Replay real Gateway frames through the same state owners used by mounted pages. */
export async function createSessionRowDeltaConsumers(initial: SessionsListResult, key: string) {
  const client = createTestGatewayClient((method, params) => {
    if (method === "sessions.list") {
      const activeOnly = (params as { activeOnly?: boolean } | undefined)?.activeOnly;
      return structuredClone({
        ...initial,
        sessions: activeOnly
          ? initial.sessions.filter((row) => row.hasActiveRun)
          : initial.sessions,
      });
    }
    if (method === "sessions.describe") {
      return { session: initial.sessions.find((row) => row.key === key) };
    }
    if (method === "chat.history") {
      return {
        messages: [],
        sessionId: initial.sessions.find((row) => row.key === key)?.sessionId,
      };
    }
    if (method === "sessions.branches") {
      return { branches: [] };
    }
    return { subscribed: true };
  });
  const gateway = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", rowMode: "sidebar", archivedFilter: "all" });
  const current = createSessionActivity(() => {});
  const history = createSessionActivity(() => {});
  await current.load(client, "current");
  await history.load(client, { personId: null, query: "", time: "all" });
  const { state } = createSessionEventState({
    client,
    sessions,
    sessionKey: key,
    currentSessionId: initial.sessions.find((row) => row.key === key)?.sessionId ?? null,
  });
  const observation = sessions.observeRow({ key, agentId: "main" }, () => {}, {
    onEvent: (event, result) => handlePageGatewayEvent(state, event, () => false, result),
  });
  return {
    dispose() {
      observation.dispose();
      current.dispose();
      history.dispose();
      sessions.dispose();
    },
    apply(event: GatewayEventFrame) {
      gateway.emitEvent(event);
      current.invalidate(event.payload);
      history.invalidate(event.payload);
    },
    snapshot() {
      return {
        sidebar: sessions.state.result,
        current: current.result,
        history: history.result,
        currentIncomplete: current.incomplete,
        chat: getChatSessionProjection(state),
        archived: state.selectedChatSessionArchived,
        // These exact samples feed sidebar/subagent elapsed-time and swarm duration rendering.
        runtimeSamples: sessions.state.result?.sessions.map((row) => ({
          key: row.key,
          runtimeMs: row.runtimeMs,
          runtimeSampledAt: row.runtimeSampledAt,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          hasActiveRun: row.hasActiveRun,
          status: row.status,
        })),
      };
    },
  };
}
