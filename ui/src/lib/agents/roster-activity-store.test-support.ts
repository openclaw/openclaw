import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestSessionCapability } from "../sessions/session-capability.test-support.ts";
import { rosterActivityStore } from "./roster-activity-store.ts";

export function rosterRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: "agent:main:main", kind: "direct", ...overrides };
}

export function rosterResult(
  preview = "",
  hasMore = false,
  sessions = [rosterRow({ lastMessagePreview: preview })],
): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions,
    hasMore,
  };
}

export function createRosterFixture(client: GatewayBrowserClient, agentIds = ["main"]) {
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    client,
    phase: "connected",
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
  });
  const sessions = createTestSessionCapability(source.gateway);
  const context = createContext(source.gateway, sessions, {
    agents: agentIds.map((id) => ({ id })),
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
  });
  return {
    source,
    sessions,
    context,
    store: rosterActivityStore(context),
    emit(payload: Record<string, unknown>, event = "sessions.changed") {
      source.publishEvent({ type: "event", event, payload });
    },
  };
}
