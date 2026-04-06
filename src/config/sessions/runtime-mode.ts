import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store-load.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry, updateSessionStore } from "./store.js";
import { mergeSessionEntry } from "./types.js";
import type { SessionEntry, SessionPlanState, SessionRuntimeMode } from "./types.js";
import { isSessionRuntimeMode } from "./types.js";

function resolveNormalizedPlanState(
  planState: SessionPlanState | undefined,
): SessionPlanState | undefined {
  if (!planState) {
    return undefined;
  }
  const content = typeof planState.content === "string" ? planState.content.trim() : undefined;
  const todos = Array.isArray(planState.todos)
    ? planState.todos
        .map((todo) => {
          const id = typeof todo?.id === "string" ? todo.id.trim() : "";
          const text = typeof todo?.text === "string" ? todo.text.trim() : "";
          return id && text
            ? {
                id,
                text,
                status: todo.status,
              }
            : null;
        })
        .filter((todo) => todo !== null)
    : undefined;
  return {
    ...(content ? { content } : {}),
    ...(todos && todos.length > 0 ? { todos } : {}),
    ...(typeof planState.enteredAt === "number" ? { enteredAt: planState.enteredAt } : {}),
    ...(typeof planState.confirmedAt === "number" ? { confirmedAt: planState.confirmedAt } : {}),
    ...(typeof planState.updatedAt === "number" ? { updatedAt: planState.updatedAt } : {}),
  };
}

export function normalizeSessionRuntimeMode(value: unknown): SessionRuntimeMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return isSessionRuntimeMode(trimmed) ? trimmed : undefined;
}

export function resolveSessionStorePathForSessionKey(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
}): { cfg: OpenClawConfig; storePath: string } {
  const cfg = params.cfg ?? loadConfig();
  const parsed = parseAgentSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  return { cfg, storePath };
}

export type SessionRuntimeStateSnapshot = {
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  runtimeMode: SessionRuntimeMode;
  planState?: SessionPlanState;
};

export function readSessionRuntimeState(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
}): SessionRuntimeStateSnapshot | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const { storePath } = resolveSessionStorePathForSessionKey({
    sessionKey,
    cfg: params.cfg,
  });
  const store = loadSessionStore(storePath);
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  const entry = resolved.existing;
  const runtimeMode =
    normalizeSessionRuntimeMode(entry?.runtimeMode) ??
    normalizeSessionRuntimeMode(entry?.acp?.runtimeOptions?.runtimeMode) ??
    "auto";
  return {
    storePath,
    sessionKey,
    storeSessionKey: resolved.normalizedKey,
    entry,
    runtimeMode,
    planState: resolveNormalizedPlanState(entry?.planState),
  };
}

export function getSessionRuntimeMode(
  sessionKey: string,
  cfg?: OpenClawConfig,
): SessionRuntimeMode | undefined {
  return readSessionRuntimeState({ sessionKey, cfg })?.runtimeMode;
}

export function getSessionPlanState(
  sessionKey: string,
  cfg?: OpenClawConfig,
): SessionPlanState | undefined {
  return readSessionRuntimeState({ sessionKey, cfg })?.planState;
}

function buildNextEntryWithRuntimeMode(params: {
  entry: SessionEntry | undefined;
  mode: SessionRuntimeMode;
}): SessionEntry {
  const nextEntry = mergeSessionEntry(params.entry, {
    runtimeMode: params.mode,
  });
  if (!params.entry?.acp) {
    return nextEntry;
  }
  nextEntry.acp = {
    ...params.entry.acp,
    runtimeOptions: {
      ...params.entry.acp.runtimeOptions,
      runtimeMode: params.mode,
    },
  };
  return nextEntry;
}

export async function setSessionRuntimeMode(
  sessionKey: string,
  mode: SessionRuntimeMode,
  cfg?: OpenClawConfig,
): Promise<SessionRuntimeStateSnapshot | null> {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return null;
  }
  const { storePath } = resolveSessionStorePathForSessionKey({
    sessionKey: normalizedSessionKey,
    cfg,
  });
  return await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey: normalizedSessionKey });
      const nextEntry = buildNextEntryWithRuntimeMode({
        entry: resolved.existing,
        mode,
      });
      store[resolved.normalizedKey] = nextEntry;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return {
        storePath,
        sessionKey: normalizedSessionKey,
        storeSessionKey: resolved.normalizedKey,
        entry: nextEntry,
        runtimeMode: mode,
        planState: resolveNormalizedPlanState(nextEntry.planState),
      };
    },
    {
      activeSessionKey: normalizeStoreSessionKey(normalizedSessionKey),
    },
  );
}

export async function updateSessionPlanState(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  mutate: (
    current: SessionPlanState | undefined,
    entry: SessionEntry | undefined,
  ) => SessionPlanState | null | undefined;
}): Promise<SessionRuntimeStateSnapshot | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const { storePath } = resolveSessionStorePathForSessionKey({
    sessionKey,
    cfg: params.cfg,
  });
  return await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      const currentEntry = resolved.existing;
      const nextPlanState = params.mutate(
        resolveNormalizedPlanState(currentEntry?.planState),
        currentEntry,
      );
      if (nextPlanState === undefined) {
        const runtimeMode =
          normalizeSessionRuntimeMode(currentEntry?.runtimeMode) ??
          normalizeSessionRuntimeMode(currentEntry?.acp?.runtimeOptions?.runtimeMode) ??
          "auto";
        return {
          storePath,
          sessionKey,
          storeSessionKey: resolved.normalizedKey,
          entry: currentEntry,
          runtimeMode,
          planState: resolveNormalizedPlanState(currentEntry?.planState),
        };
      }
      const nextEntry = mergeSessionEntry(
        currentEntry,
        nextPlanState ? { planState: resolveNormalizedPlanState(nextPlanState) } : {},
      );
      if (nextPlanState === null) {
        delete nextEntry.planState;
      }
      store[resolved.normalizedKey] = nextEntry;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      const runtimeMode =
        normalizeSessionRuntimeMode(nextEntry.runtimeMode) ??
        normalizeSessionRuntimeMode(nextEntry.acp?.runtimeOptions?.runtimeMode) ??
        "auto";
      return {
        storePath,
        sessionKey,
        storeSessionKey: resolved.normalizedKey,
        entry: nextEntry,
        runtimeMode,
        planState: resolveNormalizedPlanState(nextEntry.planState),
      };
    },
    {
      activeSessionKey: normalizeStoreSessionKey(sessionKey),
    },
  );
}
