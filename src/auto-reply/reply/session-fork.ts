import path from "node:path";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

/**
 * Default max parent token count beyond which thread/session parent forking is skipped.
 * This prevents new thread sessions from inheriting near-full parent context.
 * See #26905.
 */
const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;
const sessionForkRuntimeLoader = createLazyImportLoader(() => import("./session-fork.runtime.js"));

export type ParentForkDecision =
  | {
      status: "fork";
      maxTokens: number;
      parentTokens?: number;
    }
  | {
      status: "skip";
      reason: "parent-too-large";
      maxTokens: number;
      parentTokens: number;
      message: string;
    };

type ParentForkDecisionParams = {
  parentEntry: SessionEntry;
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
};

type ForkSessionFromParentParams = {
  parentEntry: SessionEntry;
  agentId: string;
  config?: OpenClawConfig;
  sessionsDir?: string;
  targetSessionsDir?: string;
};

export type ForkedParentSessionEntry = {
  sessionId: string;
  sessionFile: string;
};

export type ForkSessionEntryFromParentResult =
  | {
      status: "forked";
      fork: ForkedParentSessionEntry;
      parentEntry: SessionEntry;
      sessionEntry: SessionEntry;
      decision: Extract<ParentForkDecision, { status: "fork" }>;
    }
  | {
      status: "skipped";
      reason: "existing-entry" | "decision-skip";
      parentEntry?: SessionEntry;
      sessionEntry: SessionEntry;
      decision?: ParentForkDecision;
    }
  | { status: "missing-entry" }
  | { status: "missing-parent" }
  | { status: "failed" };

export type ForkSessionEntryFromParentParams = Omit<ForkSessionFromParentParams, "parentEntry"> & {
  parentSessionKey: string;
  parentStoreKeys?: readonly string[];
  sessionKey: string;
  sessionStoreKeys?: readonly string[];
  storePath?: string;
  fallbackEntry?: SessionEntry;
  patch?: (params: {
    entry: SessionEntry;
    parentEntry: SessionEntry;
    fork: ForkedParentSessionEntry;
    decision: Extract<ParentForkDecision, { status: "fork" }>;
  }) => Partial<SessionEntry>;
  skipForkWhen?: (entry: SessionEntry) => boolean;
  skipPatch?: (entry: SessionEntry) => Partial<SessionEntry> | null;
  decisionSkipPatch?: (params: {
    decision: Extract<ParentForkDecision, { status: "skip" }>;
    entry: SessionEntry;
    parentEntry: SessionEntry;
  }) => Partial<SessionEntry> | null;
};

function loadSessionForkRuntime(): Promise<typeof import("./session-fork.runtime.js")> {
  return sessionForkRuntimeLoader.load();
}

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

function resolveParentForkStorePath(params: {
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
}): string {
  return (
    params.storePath ?? resolveStorePath(params.config?.session?.store, { agentId: params.agentId })
  );
}

function resolveParentForkSessionsDir(params: {
  agentId: string;
  config?: OpenClawConfig;
  sessionsDir?: string;
}): string {
  return params.sessionsDir ?? path.dirname(resolveParentForkStorePath(params));
}

export async function resolveParentForkDecision(
  params: ParentForkDecisionParams,
): Promise<ParentForkDecision> {
  const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
  const parentTokens = await resolveParentForkTokenCount({
    parentEntry: params.parentEntry,
    storePath: resolveParentForkStorePath(params),
  });
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
}

export async function forkSessionFromParent(
  params: ForkSessionFromParentParams,
): Promise<{ sessionId: string; sessionFile: string } | null> {
  const runtime = await loadSessionForkRuntime();
  return runtime.forkSessionFromParentRuntime({
    ...params,
    sessionsDir: resolveParentForkSessionsDir(params),
  });
}

function resolveEntryFromStoreKeys(params: {
  store: Record<string, SessionEntry>;
  keys: readonly string[];
}): SessionEntry | undefined {
  for (const key of params.keys) {
    const entry = params.store[key];
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

function persistForkedSessionEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
  sessionStoreKeys?: readonly string[];
  existing: SessionEntry;
  patch: Partial<SessionEntry>;
}): SessionEntry {
  const next = mergeSessionEntry(params.existing, params.patch);
  params.store[params.sessionKey] = next;
  for (const key of params.sessionStoreKeys ?? []) {
    if (key !== params.sessionKey) {
      delete params.store[key];
    }
  }
  return next;
}

/**
 * Forks the parent transcript and persists the child session entry through one
 * storage boundary operation.
 */
export async function forkSessionEntryFromParent(
  params: ForkSessionEntryFromParentParams,
): Promise<ForkSessionEntryFromParentResult> {
  const storePath = resolveParentForkStorePath(params);
  return await updateSessionStore(
    storePath,
    async (store) => {
      const parentEntry = resolveEntryFromStoreKeys({
        store,
        keys: params.parentStoreKeys ?? [params.parentSessionKey],
      });
      if (!parentEntry?.sessionId) {
        return { status: "missing-parent" };
      }

      const entry =
        resolveEntryFromStoreKeys({
          store,
          keys: params.sessionStoreKeys ?? [params.sessionKey],
        }) ?? params.fallbackEntry;
      if (!entry) {
        return { status: "missing-entry" };
      }

      if (params.skipForkWhen?.(entry)) {
        const patch = params.skipPatch?.(entry);
        const sessionEntry = patch
          ? persistForkedSessionEntry({
              store,
              sessionKey: params.sessionKey,
              sessionStoreKeys: params.sessionStoreKeys,
              existing: entry,
              patch,
            })
          : entry;
        return { status: "skipped", reason: "existing-entry", parentEntry, sessionEntry };
      }

      const decision = await resolveParentForkDecision({
        parentEntry,
        agentId: params.agentId,
        config: params.config,
        storePath,
      });
      if (decision.status === "skip") {
        const patch = params.decisionSkipPatch?.({ decision, entry, parentEntry });
        const sessionEntry = patch
          ? persistForkedSessionEntry({
              store,
              sessionKey: params.sessionKey,
              sessionStoreKeys: params.sessionStoreKeys,
              existing: entry,
              patch,
            })
          : entry;
        return {
          status: "skipped",
          reason: "decision-skip",
          parentEntry,
          sessionEntry,
          decision,
        };
      }

      const fork = await forkSessionFromParent({
        parentEntry,
        agentId: params.agentId,
        config: params.config,
        sessionsDir: params.sessionsDir ?? path.dirname(storePath),
      });
      if (!fork) {
        return { status: "failed" };
      }
      const sessionEntry = persistForkedSessionEntry({
        store,
        sessionKey: params.sessionKey,
        sessionStoreKeys: params.sessionStoreKeys,
        existing: entry,
        patch: {
          ...params.patch?.({ entry, parentEntry, fork, decision }),
          sessionId: fork.sessionId,
          sessionFile: fork.sessionFile,
          forkedFromParent: true,
        },
      });
      return {
        status: "forked",
        fork,
        parentEntry,
        sessionEntry,
        decision,
      };
    },
    {
      skipSaveWhenResult: (result) =>
        result.status === "missing-entry" ||
        result.status === "missing-parent" ||
        result.status === "failed" ||
        (result.status === "skipped" && result.sessionEntry === params.fallbackEntry),
    },
  );
}

async function resolveParentForkTokenCount(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const runtime = await loadSessionForkRuntime();
  return runtime.resolveParentForkTokenCountRuntime(params);
}
