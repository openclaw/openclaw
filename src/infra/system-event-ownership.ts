import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const eventOwners = new WeakMap<object, string>();
const optionOwners = new WeakMap<object, string>();

function normalizeOwnerAgentId(agentId: string | null | undefined): string | null {
  return normalizeOptionalString(agentId) ? normalizeAgentId(agentId) : null;
}

export function withSystemEventOwner<T extends object>(options: T, agentId: string): T {
  optionOwners.set(options, normalizeAgentId(agentId));
  return options;
}

export function resolveSystemEventOptionsOwnerAgentId(options: object): string | null {
  return optionOwners.get(options) ?? null;
}

export function recordSystemEventOwner(event: object, agentId: string | null): void {
  const normalized = normalizeOwnerAgentId(agentId);
  if (normalized) {
    eventOwners.set(event, normalized);
  }
}

export function cloneSystemEventOwner(source: object, clone: object): void {
  const ownerAgentId = eventOwners.get(source);
  if (ownerAgentId) {
    eventOwners.set(clone, ownerAgentId);
  }
}

export function resolveSystemEventOwnerAgentId(event: object): string | null {
  return eventOwners.get(event) ?? null;
}

export function selectAgentSystemEvents<T extends object>(
  events: readonly T[],
  agentId: string,
): T[] {
  const normalizedAgentId = normalizeAgentId(agentId);
  // Unowned events retain their legacy first-consumer semantics. Owner-marked
  // events stay invisible to other agents sharing the transient global queue.
  return events.filter((event) => {
    const ownerAgentId = resolveSystemEventOwnerAgentId(event);
    return ownerAgentId === null || ownerAgentId === normalizedAgentId;
  });
}
