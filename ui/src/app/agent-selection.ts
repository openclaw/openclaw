import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";

type AgentSelectionGateway = {
  readonly snapshot: {
    client: GatewayBrowserClient | null;
    assistantAgentId: string | null;
  };
  subscribe: (listener: (snapshot: AgentSelectionGateway["snapshot"]) => void) => () => void;
};

export type AgentSelectionState = {
  selectedId: string | null;
};

export type AgentSelectionCapability = {
  readonly state: AgentSelectionState;
  set: (agentId: string | null) => void;
  subscribe: (listener: (state: AgentSelectionState) => void) => () => void;
};

export function createAgentSelectionCapability(
  gateway: AgentSelectionGateway,
): AgentSelectionCapability {
  let state: AgentSelectionState = {
    selectedId: gateway.snapshot.assistantAgentId
      ? normalizeAgentId(gateway.snapshot.assistantAgentId)
      : null,
  };
  let client = gateway.snapshot.client;
  const listeners = new Set<(next: AgentSelectionState) => void>();

  const publish = (selectedId: string | null) => {
    if (state.selectedId === selectedId) {
      return;
    }
    state = { selectedId };
    for (const listener of listeners) {
      listener(state);
    }
  };

  gateway.subscribe((next) => {
    if (next.client !== client) {
      client = next.client;
      publish(next.assistantAgentId ? normalizeAgentId(next.assistantAgentId) : null);
    }
  });

  return {
    get state() {
      return state;
    },
    set(agentId) {
      publish(agentId?.trim() ? normalizeAgentId(agentId) : null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
