import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStoreEntry,
} from "../../config/sessions.js";

type SessionGenerationToken =
  | {
      sessionKey: string;
      generation: number;
    }
  | undefined;

type SessionGenerationListener = (params: { sessionKey: string; generation: number }) => void;

const SESSION_GENERATIONS = new Map<string, number>();
const SESSION_GENERATION_LISTENERS = new Map<string, Set<SessionGenerationListener>>();

function normalizeSessionKey(sessionKey?: string): string | undefined {
  const normalized = sessionKey?.trim().toLowerCase();
  return normalized || undefined;
}

export async function beginSessionGeneration(params: {
  sessionKey?: string;
  cfg?: OpenClawConfig;
}): Promise<SessionGenerationToken> {
  const normalized = normalizeSessionKey(params.sessionKey);
  if (!normalized) {
    return undefined;
  }

  let persistedGeneration = 0;
  let storePath: string | undefined;
  let hasPersistedEntry = false;
  if (params.cfg) {
    try {
      const agentId = resolveSessionAgentId({ sessionKey: normalized, config: params.cfg });
      storePath = resolveStorePath(params.cfg.session?.store, { agentId });
      const entry = loadSessionStore(storePath)[normalized];
      hasPersistedEntry = Boolean(entry);
      persistedGeneration = entry?.replyGeneration ?? 0;
    } catch {
      // Best-effort persistence only.
    }
  }

  const nextGeneration =
    Math.max(SESSION_GENERATIONS.get(normalized) ?? 0, persistedGeneration) + 1;
  SESSION_GENERATIONS.set(normalized, nextGeneration);

  const listeners = SESSION_GENERATION_LISTENERS.get(normalized);
  if (listeners?.size) {
    for (const listener of listeners) {
      try {
        listener({ sessionKey: normalized, generation: nextGeneration });
      } catch {
        // Listener notifications are best-effort.
      }
    }
  }

  if (storePath && hasPersistedEntry) {
    await updateSessionStoreEntry({
      storePath,
      sessionKey: normalized,
      update: async () => ({ replyGeneration: nextGeneration }),
    }).catch(() => null);
  }

  return {
    sessionKey: normalized,
    generation: nextGeneration,
  };
}

export function isSessionGenerationCurrent(token: SessionGenerationToken): boolean {
  if (!token) {
    return true;
  }
  return SESSION_GENERATIONS.get(token.sessionKey) === token.generation;
}

export function registerSessionGenerationListener(
  sessionKey: string,
  listener: SessionGenerationListener,
): () => void {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) {
    return () => {};
  }
  const listeners =
    SESSION_GENERATION_LISTENERS.get(normalized) ?? new Set<SessionGenerationListener>();
  listeners.add(listener);
  SESSION_GENERATION_LISTENERS.set(normalized, listeners);
  return () => {
    const current = SESSION_GENERATION_LISTENERS.get(normalized);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      SESSION_GENERATION_LISTENERS.delete(normalized);
    }
  };
}

export function __resetSessionGenerationsForTest(): void {
  SESSION_GENERATIONS.clear();
  SESSION_GENERATION_LISTENERS.clear();
}
