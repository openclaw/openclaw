import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";

const stores = resolveGlobalSingleton<{
  resolve?: (sessionKey: string, agentId?: string) => string;
  prepare?: (sessionKey: string, agentId?: string) => Promise<string>;
  owners: Map<symbol, () => void>;
}>(
  Symbol.for("openclaw.systemEventStores"),
  () => ({ owners: new Map() }),
  () => {
    stores.resolve = undefined;
    stores.prepare = undefined;
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

/** Prepare the current owner's path without invoking its synchronous discovery fallback. */
export function prepareSystemEventStorePath(
  sessionKey: string,
  agentId?: string,
): Promise<string> | undefined {
  const resolve = stores.resolve;
  if (!resolve) {
    return undefined;
  }
  const preparing = stores.prepare
    ? stores.prepare(sessionKey, agentId)
    : Promise.resolve(resolve(sessionKey, agentId));
  return preparing.then((pathname) => {
    if (stores.resolve !== resolve) {
      throw new Error("System-event store owner changed during path preparation");
    }
    return pathname;
  });
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

/** A resumed operation must not discover a replacement owner's store on the host. */
export function captureSystemEventStoreCurrentCheck(sessionKey: string, agentId?: string) {
  const resolve = stores.resolve;
  return (storePath: string | null | undefined) =>
    stores.resolve === resolve && isSystemEventStoreCurrent(sessionKey, storePath, agentId);
}

/** The accepted Gateway store selection owns retirement; same-store handoff retains its facts. */
export function publishSystemEventStoreResolver(
  resolve: typeof stores.resolve,
  prepare?: typeof stores.prepare,
): void {
  stores.resolve = resolve;
  stores.prepare = prepare;
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
