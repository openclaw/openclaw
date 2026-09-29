import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";

const stores = resolveGlobalSingleton<{
  resolve?: (sessionKey: string, agentId?: string) => string;
  owners: Map<symbol, () => void>;
}>(
  Symbol.for("openclaw.systemEventStores"),
  () => ({ owners: new Map() }),
  () => {
    stores.resolve = undefined;
  },
  "close-only",
);

export function getSystemEventStorePath(sessionKey: string, agentId?: string): string | undefined {
  try {
    return stores.resolve?.(sessionKey, agentId);
  } catch {
    return undefined;
  }
}

export function isSystemEventStoreCurrent(
  sessionKey: string | undefined,
  storePath: string | null | undefined,
  agentId?: string,
): boolean {
  return (
    !sessionKey ||
    (storePath !== null &&
      (!stores.resolve ||
        (storePath !== undefined && storePath === getSystemEventStorePath(sessionKey, agentId))))
  );
}

/** The accepted Gateway store selection owns retirement; same-store handoff retains its facts. */
export function publishSystemEventStoreResolver(resolve: typeof stores.resolve): void {
  stores.resolve = resolve;
  for (const retire of stores.owners.values()) {
    retire();
  }
}

export function registerSystemEventStoreOwner(key: symbol, retire: () => void): void {
  stores.owners.set(key, retire);
}

export function recordSystemEventStoreReplaced(): void {
  emitHeartbeatEvent({
    status: "skipped",
    reason: "store-replaced",
    message: "Dropped: session store replaced.",
  });
}

/** Queue identity is scoped without rewriting the caller's persisted session key. */
export function resolveSystemEventQueueKey(sessionKey: string, agentId?: string): string {
  if (!sessionKey.trim()) {
    throw new Error("system events require a sessionKey");
  }
  const owner = resolveAgentIdFromSessionKey(sessionKey, agentId);
  if (agentId && owner !== normalizeAgentId(agentId)) {
    throw new Error("System event owner does not match its session key.");
  }
  return toAgentStoreSessionKey({ agentId: owner, requestKey: sessionKey });
}

export function withSystemEventOwner<T extends { sessionKey: string }>(
  options: T,
  agentId: string,
): Omit<T, "sessionKey"> & { sessionKey: string } {
  return { ...options, sessionKey: resolveSystemEventQueueKey(options.sessionKey, agentId) };
}
