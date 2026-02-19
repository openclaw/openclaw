/**
 * Agent / Agent System Resolution — Shared Module
 *
 * Provides unified search across agents AND agent systems by ID,
 * exact name, or substring match. Extracted from extensions/ask-agent
 * for reuse in CLI commands, plugins, and sync logic.
 *
 * Reusable across: plugins, CLI commands, skill generators.
 */

import type { Agent, AgentSystem } from "./types.js";
import { normalizeAgentStatus } from "./agent-status.js";
import { normalizeAgentSystemStatus } from "./agent-system-status.js";

// ---------------------------------------------------------------------------
// Addressable — unified interface for agents and agent systems
// ---------------------------------------------------------------------------

export type AddressableKind = "agent" | "agent-system";

export type Addressable = {
  id: string;
  name: string;
  description?: string;
  status: string;
  endpoint?: string;
  kind: AddressableKind;
};

export type ResolvedAddressable = { ok: true; target: Addressable } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export function agentToAddressable(agent: Agent): Addressable {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: normalizeAgentStatus(agent.status),
    endpoint: agent.endpoint,
    kind: "agent",
  };
}

export function agentSystemToAddressable(system: AgentSystem): Addressable {
  return {
    id: system.id,
    name: system.name,
    description: system.description,
    status: normalizeAgentSystemStatus(system.status),
    endpoint: system.endpoint,
    kind: "agent-system",
  };
}

// ---------------------------------------------------------------------------
// Endpoint computation
// ---------------------------------------------------------------------------

/** Compute the A2A endpoint URL for an addressable target. */
export function computeEndpoint(target: Addressable): string {
  if (target.endpoint) {
    return target.endpoint;
  }
  const suffix = target.kind === "agent" ? "agent" : "agent-system";
  return `https://${target.id}-${suffix}.ai-agent.inference.cloud.ru`;
}

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

/**
 * Resolve a query (ID, exact name, or substring) against a unified list
 * of agents and agent systems.
 */
export function resolveAddressable(items: Addressable[], query: string): ResolvedAddressable {
  // Exact ID match
  const byId = items.find((a) => a.id === query);
  if (byId) {
    return { ok: true, target: byId };
  }

  // Exact name match (case-insensitive)
  const lowerQuery = query.toLowerCase();
  const byName = items.find((a) => a.name.toLowerCase() === lowerQuery);
  if (byName) {
    return { ok: true, target: byName };
  }

  // Substring match
  const matches = items.filter((a) => a.name.toLowerCase().includes(lowerQuery));
  if (matches.length === 1) {
    return { ok: true, target: matches[0] };
  }

  if (matches.length > 1) {
    const list = matches
      .map((a) => `  - ${a.name} (${a.status}, ${a.kind}, ID: ${a.id.slice(0, 8)})`)
      .join("\n");
    return {
      ok: false,
      error: `Multiple resources match "${query}":\n${list}\n\nPlease specify the exact name or ID.`,
    };
  }

  // No match — show available resources
  if (items.length === 0) {
    return { ok: false, error: "No agents or agent systems found in this project." };
  }
  const list = items.map((a) => `  - ${a.name} (${a.status}, ${a.kind})`).join("\n");
  return {
    ok: false,
    error: `Resource "${query}" not found. Available:\n${list}`,
  };
}

/**
 * Legacy-compatible resolver that works with Agent[] only.
 * Delegates to resolveAddressable with agent kind.
 */
export function resolveAgent(
  agents: Agent[],
  query: string,
): { ok: true; agent: Agent } | { ok: false; error: string } {
  const items = agents.map(agentToAddressable);
  const result = resolveAddressable(items, query);
  if (!result.ok) {
    return result;
  }
  const agent = agents.find((a) => a.id === result.target.id);
  if (!agent) {
    return { ok: false, error: `Agent "${query}" not found.` };
  }
  return { ok: true, agent };
}
