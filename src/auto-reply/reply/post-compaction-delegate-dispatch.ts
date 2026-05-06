import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
  type SpawnSubagentResult,
} from "../../agents/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { resolveSessionStoreEntry, updateSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateChainId } from "../../infra/secure-random.js";
import {
  drainPendingSessionDeliveries,
  type SessionDeliveryRecoveryLogger,
} from "../../infra/session-delivery-queue-recovery.js";
import {
  enqueuePostCompactionDelegateDelivery,
  type QueuedSessionDelivery,
  type SessionDeliveryContext,
} from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { consumeStagedPostCompactionDelegates } from "../continuation-delegate-store.js";
import { resolveContinuationRuntimeConfig } from "../continuation/config.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";
import type { ContinuationSignal } from "../tokens.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import type { FollowupRun } from "./queue/types.js";

export type QueuedPostCompactionDelegateDelivery = Extract<
  QueuedSessionDelivery,
  { kind: "postCompactionDelegate" }
>;

export type PostCompactionDelegateSpawn = (
  params: SpawnSubagentParams,
  context: SpawnSubagentContext,
) => Promise<SpawnSubagentResult>;

export type PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent(text: string, options: { sessionKey: string; traceparent?: string }): void;
  getRuntimeConfig(): OpenClawConfig;
  loadSessionStore(storePath: string): Record<string, SessionEntry>;
  log(message: string): void;
  now(): number;
  resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
  resolveSessionAgentId(params: { sessionKey?: string; config?: OpenClawConfig }): string;
  resolveStorePath(store?: string, opts?: { agentId?: string; env?: NodeJS.ProcessEnv }): string;
  spawnSubagentDirect: PostCompactionDelegateSpawn;
};

export type PostCompactionDelegateDispatchDeps = {
  consumeStagedPostCompactionDelegates(sessionKey: string): SessionPostCompactionDelegate[];
  drainPostCompactionDelegateDeliveries(params: {
    entryIds?: readonly string[];
    log: SessionDeliveryRecoveryLogger;
    sessionKey: string;
  }): Promise<void>;
  enqueuePostCompactionDelegateDelivery(params: {
    sessionKey: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
  }): Promise<string>;
  enqueueSystemEvent(text: string, options: { sessionKey: string; traceparent?: string }): void;
  log(message: string): void;
  now(): number;
  readPostCompactionContext(
    workspaceDir: string,
    options: { cfg: OpenClawConfig; agentId: string },
  ): Promise<string | null>;
  resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string;
  resolveContinuationRuntimeConfig(cfg: OpenClawConfig): ContinuationRuntimeConfig;
  resolveSessionAgentId(params: { sessionKey?: string; config?: OpenClawConfig }): string;
};

export type DispatchPostCompactionDelegatesParams = {
  cfg: OpenClawConfig;
  compactionCount: number | undefined;
  continuationSignalKind?: ContinuationSignal["kind"];
  followupRun: FollowupRun;
  postCompactionDelegatesToPreserve: SessionPostCompactionDelegate[];
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
};

export type DispatchPostCompactionDelegatesResult = {
  queuedDelegates: number;
  droppedDelegates: number;
};

const defaultRecoveryLog: SessionDeliveryRecoveryLogger = {
  info: (message) => defaultRuntime.log(message),
  warn: (message) => defaultRuntime.log(message),
  error: (message) => defaultRuntime.log(message),
};

const defaultPostCompactionDelegateDeliveryDeps: PostCompactionDelegateDeliveryDeps = {
  enqueueSystemEvent,
  getRuntimeConfig,
  loadSessionStore,
  log: (message) => defaultRuntime.log(message),
  now: () => Date.now(),
  resolveContinuationRuntimeConfig,
  resolveSessionAgentId,
  resolveStorePath,
  spawnSubagentDirect,
};

const defaultPostCompactionDelegateDispatchDeps: PostCompactionDelegateDispatchDeps = {
  consumeStagedPostCompactionDelegates,
  drainPostCompactionDelegateDeliveries,
  enqueuePostCompactionDelegateDelivery,
  enqueueSystemEvent,
  log: (message) => defaultRuntime.log(message),
  now: () => Date.now(),
  readPostCompactionContext,
  resolveAgentWorkspaceDir,
  resolveContinuationRuntimeConfig,
  resolveSessionAgentId,
};

export const POST_COMPACTION_DELEGATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function enqueueSystemEventOrLog(params: {
  deps: Pick<PostCompactionDelegateDispatchDeps, "enqueueSystemEvent" | "log">;
  label: string;
  sessionKey: string;
  text: string;
}): void {
  try {
    params.deps.enqueueSystemEvent(params.text, { sessionKey: params.sessionKey });
  } catch (err) {
    params.deps.log(
      `Failed to enqueue ${params.label} for ${params.sessionKey}: ${formatErrorMessage(err)}`,
    );
  }
}

function syncPendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  delegates: SessionPostCompactionDelegate[] | undefined;
}) {
  if (params.sessionEntry) {
    params.sessionEntry.pendingPostCompactionDelegates = params.delegates;
  }
  if (params.sessionStore?.[params.sessionKey]) {
    params.sessionStore[params.sessionKey] = {
      ...params.sessionStore[params.sessionKey],
      pendingPostCompactionDelegates: params.delegates,
    };
  }
}

export function normalizePostCompactionDelegate(
  delegate: SessionPostCompactionDelegate,
): SessionPostCompactionDelegate {
  const legacySilentWake = delegate.silent == null && delegate.silentWake == null;
  const silentWake = legacySilentWake ? true : delegate.silentWake === true;
  const silent = legacySilentWake ? true : delegate.silent === true || silentWake;
  const firstArmedAt = delegate.firstArmedAt ?? delegate.createdAt;

  return {
    task: delegate.task,
    createdAt: delegate.createdAt,
    firstArmedAt,
    ...(delegate.silent != null || legacySilentWake ? { silent } : {}),
    ...(delegate.silentWake != null || legacySilentWake ? { silentWake } : {}),
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: delegate.targetSessionKeys }
      : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.traceparent ? { traceparent: delegate.traceparent } : {}),
  };
}

function formatTaskPreview(task: string): string {
  return JSON.stringify(task.length > 120 ? `${task.slice(0, 117)}...` : task);
}

export async function persistPendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  delegates: SessionPostCompactionDelegate[];
}): Promise<SessionPostCompactionDelegate[]> {
  if (params.delegates.length === 0) {
    return (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(
      normalizePostCompactionDelegate,
    );
  }

  const normalizedDelegates = params.delegates.map(normalizePostCompactionDelegate);
  const localExisting = (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(
    normalizePostCompactionDelegate,
  );
  const combinedLocal = [...localExisting, ...normalizedDelegates];

  if (!params.storePath) {
    syncPendingPostCompactionDelegates({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      delegates: combinedLocal,
    });
    return combinedLocal;
  }

  const persisted = await updateSessionStore(params.storePath, (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const current =
      resolved.existing ??
      params.sessionStore?.[params.sessionKey] ??
      params.sessionEntry ??
      undefined;
    const combined = [
      ...(current?.pendingPostCompactionDelegates ?? []).map(normalizePostCompactionDelegate),
      ...normalizedDelegates,
    ];
    if (current) {
      store[resolved.normalizedKey] = {
        ...current,
        pendingPostCompactionDelegates: combined,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    }
    return combined;
  });

  syncPendingPostCompactionDelegates({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    delegates: persisted.length > 0 ? persisted : combinedLocal,
  });
  return persisted.length > 0 ? persisted : combinedLocal;
}

export async function takePendingPostCompactionDelegates(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}): Promise<SessionPostCompactionDelegate[]> {
  const localDelegates = (params.sessionEntry?.pendingPostCompactionDelegates ?? []).map(
    normalizePostCompactionDelegate,
  );

  if (!params.storePath) {
    syncPendingPostCompactionDelegates({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      delegates: undefined,
    });
    return localDelegates;
  }

  const persisted = await updateSessionStore(params.storePath, (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const current =
      resolved.existing ??
      params.sessionStore?.[params.sessionKey] ??
      params.sessionEntry ??
      undefined;
    const delegates = (current?.pendingPostCompactionDelegates ?? []).map(
      normalizePostCompactionDelegate,
    );
    if (current && delegates.length > 0) {
      store[resolved.normalizedKey] = {
        ...current,
        pendingPostCompactionDelegates: undefined,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    }
    return delegates;
  });

  syncPendingPostCompactionDelegates({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    delegates: undefined,
  });
  return persisted.length > 0 ? persisted : localDelegates;
}

export function buildPostCompactionLifecycleEvent(params: {
  compactionCount?: number;
  /**
   * Number of delegates accepted into the persistent delivery queue this
   * dispatch. NOTE: this is the queued count (post-`enqueue` accept,
   * pre-spawn). The actual spawn happens asynchronously in the
   * fire-and-forget drain triggered after this event is emitted, so this
   * count is an upper bound on what will eventually be released into the
   * fresh session — individual queued entries may still fail to spawn
   * (their failure is recorded as a queue retry, not reflected here).
   *
   * Named `queuedDelegates` to make the semantic accurate; the previous
   * agent-runner path counted accepted
   * spawns, but the queue-extraction architecture cannot count spawns
   * synchronously without awaiting the drain. The honest name is
   * `queuedDelegates`.
   */
  queuedDelegates: number;
  droppedDelegates: number;
}): string {
  const parts = [
    `[system:post-compaction] Session compacted at ${new Date().toISOString()}.`,
    typeof params.compactionCount === "number"
      ? `Compaction count: ${params.compactionCount}.`
      : undefined,
    `Queued ${params.queuedDelegates} post-compaction delegate(s) for delivery into the fresh session.`,
    params.droppedDelegates > 0
      ? `${params.droppedDelegates} delegate(s) were not released into the fresh session.`
      : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

async function persistPostCompactionDelegateChainState(params: {
  count: number;
  log: (message: string) => void;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionStore?: Record<string, SessionEntry>;
  startedAt: number;
  storePath?: string;
  tokens: number;
}): Promise<void> {
  // Mint or reuse `continuationChainId` (UUIDv7) so the post-compaction
  // handoff carries the same correlation key that
  // `agent-runner.ts:persistContinuationChainState` would have used
  // before compaction. If the pre-compaction sessionEntry already had
  // a chain id, reuse it (chain survives the compaction boundary);
  // otherwise mint fresh (this is the chain's first persisted step
  // post-handoff).
  const previousChainId = params.sessionEntry?.continuationChainId;
  const chainId = previousChainId ?? generateChainId();
  if (params.sessionEntry) {
    params.sessionEntry.continuationChainCount = params.count;
    params.sessionEntry.continuationChainStartedAt = params.startedAt;
    params.sessionEntry.continuationChainTokens = params.tokens;
    params.sessionEntry.continuationChainId = chainId;
  }
  if (params.sessionStore) {
    const resolved = resolveSessionStoreEntry({
      store: params.sessionStore,
      sessionKey: params.sessionKey,
    });
    const existingEntry =
      resolved.existing ?? params.sessionStore[params.sessionKey] ?? params.sessionEntry;
    if (existingEntry) {
      params.sessionStore[resolved.normalizedKey] = {
        ...existingEntry,
        continuationChainCount: params.count,
        continuationChainStartedAt: params.startedAt,
        continuationChainTokens: params.tokens,
        continuationChainId: chainId,
      };
      for (const legacyKey of resolved.legacyKeys) {
        delete params.sessionStore[legacyKey];
      }
    }
  }
  if (params.storePath) {
    try {
      await updateSessionStore(params.storePath, (store) => {
        const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
        const existingEntry = resolved.existing ?? store[params.sessionKey];
        if (existingEntry) {
          store[resolved.existing ? resolved.normalizedKey : params.sessionKey] = {
            ...existingEntry,
            continuationChainCount: params.count,
            continuationChainStartedAt: params.startedAt,
            continuationChainTokens: params.tokens,
            continuationChainId: chainId,
          };
          if (resolved.existing) {
            for (const legacyKey of resolved.legacyKeys) {
              delete store[legacyKey];
            }
          }
        }
      });
    } catch (err) {
      params.log(
        `Failed to persist post-compaction delegate chain state for ${params.sessionKey}: ${String(
          err,
        )}`,
      );
      // Rethrow so `deliverQueuedPostCompactionDelegate` rejects, the queue
      // entry stays in `pending/` with a bumped retryCount, and the next
      // unfiltered drain re-considers it once backoff has elapsed. Without
      // this, the queue ack-removes the entry while the on-disk chain count
      // is stale, allowing the next compaction-delegate to overrun
      // `maxChainLength`.
      throw err;
    }
  }
}

function resolvePostCompactionDeliveryContext(
  followupRun: FollowupRun,
): SessionDeliveryContext | undefined {
  const deliveryContext: SessionDeliveryContext = {
    ...(followupRun.originatingChannel ? { channel: followupRun.originatingChannel } : {}),
    ...(followupRun.originatingTo ? { to: followupRun.originatingTo } : {}),
    ...(followupRun.originatingAccountId ? { accountId: followupRun.originatingAccountId } : {}),
    ...(followupRun.originatingThreadId != null
      ? { threadId: followupRun.originatingThreadId }
      : {}),
  };
  return Object.keys(deliveryContext).length > 0 ? deliveryContext : undefined;
}

function isPostCompactionDelegateEntry(
  entry: QueuedSessionDelivery,
): entry is QueuedPostCompactionDelegateDelivery {
  return entry.kind === "postCompactionDelegate";
}

export async function deliverQueuedPostCompactionDelegate(
  params: {
    entry: QueuedPostCompactionDelegateDelivery;
  },
  deps: PostCompactionDelegateDeliveryDeps = defaultPostCompactionDelegateDeliveryDeps,
): Promise<void> {
  const cfg = deps.getRuntimeConfig();
  const agentId = deps.resolveSessionAgentId({
    sessionKey: params.entry.sessionKey,
    config: cfg,
  });
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const sessionStore = deps.loadSessionStore(storePath);
  const resolved = resolveSessionStoreEntry({
    store: sessionStore,
    sessionKey: params.entry.sessionKey,
  });
  const sessionEntry = resolved.existing ?? sessionStore[params.entry.sessionKey];
  const { maxChainLength: maxCompactionChainLength, costCapTokens: compactionCostCapTokens } =
    deps.resolveContinuationRuntimeConfig(cfg);
  const currentCompactionChainCount = sessionEntry?.continuationChainCount ?? 0;
  const compactionChainTokens = sessionEntry?.continuationChainTokens ?? 0;

  if (currentCompactionChainCount >= maxCompactionChainLength) {
    deps.log(
      `Post-compaction delegate rejected: chain length ${currentCompactionChainCount} >= ${maxCompactionChainLength} for session ${params.entry.sessionKey}`,
    );
    deps.enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: chain length ${maxCompactionChainLength} reached. Task: ${params.entry.task}`,
      {
        sessionKey: params.entry.sessionKey,
        ...(params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}),
      },
    );
    return;
  }

  if (compactionCostCapTokens > 0 && compactionChainTokens > compactionCostCapTokens) {
    deps.log(
      `Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}) for session ${params.entry.sessionKey}`,
    );
    deps.enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: cost cap exceeded (${compactionChainTokens} > ${compactionCostCapTokens}). Task: ${params.entry.task}`,
      {
        sessionKey: params.entry.sessionKey,
        ...(params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}),
      },
    );
    return;
  }

  const nextCompactionChainCount = currentCompactionChainCount + 1;
  deps.log(
    `Post-compaction delegate dispatch for session ${params.entry.sessionKey}: ${params.entry.task}`,
  );
  const delegateWakeOnReturn = params.entry.silentWake ?? true;
  const delegateSilentAnnounce = params.entry.silent ?? delegateWakeOnReturn;
  const spawnResult = await deps.spawnSubagentDirect(
    {
      task:
        `[continuation:post-compaction] ` +
        `[continuation:chain-hop:${nextCompactionChainCount}] ` +
        `Compaction just completed. Carry this working state to the post-compaction session: ${params.entry.task}`,
      ...(delegateSilentAnnounce ? { silentAnnounce: true } : {}),
      ...(delegateWakeOnReturn ? { silentAnnounce: true, wakeOnReturn: true } : {}),
      ...(params.entry.targetSessionKey
        ? { continuationTargetSessionKey: params.entry.targetSessionKey }
        : {}),
      ...(params.entry.targetSessionKeys && params.entry.targetSessionKeys.length > 0
        ? { continuationTargetSessionKeys: params.entry.targetSessionKeys }
        : {}),
      ...(params.entry.fanoutMode ? { continuationFanoutMode: params.entry.fanoutMode } : {}),
      drainsContinuationDelegateQueue: true,
      ...(params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}),
    },
    {
      agentSessionKey: params.entry.sessionKey,
      agentChannel: params.entry.deliveryContext?.channel,
      agentAccountId: params.entry.deliveryContext?.accountId,
      agentTo: params.entry.deliveryContext?.to,
      agentThreadId: params.entry.deliveryContext?.threadId,
    },
  );
  if (spawnResult.status !== "accepted") {
    throw new Error(`post-compaction delegate spawn ${spawnResult.status}`);
  }

  deps.enqueueSystemEvent(
    `[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: ${params.entry.task}`,
    {
      sessionKey: params.entry.sessionKey,
      ...(params.entry.traceparent ? { traceparent: params.entry.traceparent } : {}),
    },
  );
  await persistPostCompactionDelegateChainState({
    count: nextCompactionChainCount,
    log: (message) => deps.log(message),
    sessionEntry,
    sessionKey: params.entry.sessionKey,
    sessionStore,
    startedAt: sessionEntry?.continuationChainStartedAt ?? deps.now(),
    storePath,
    tokens: compactionChainTokens,
  });
}

export async function drainPostCompactionDelegateDeliveries(params: {
  entryIds?: readonly string[];
  log?: SessionDeliveryRecoveryLogger;
  sessionKey?: string;
  stateDir?: string;
  deliveryDeps?: PostCompactionDelegateDeliveryDeps;
}): Promise<void> {
  const entryIds = new Set(params.entryIds ?? []);
  await drainPendingSessionDeliveries({
    drainKey: `post-compaction-delegate:${params.sessionKey ?? "all"}`,
    logLabel: "post-compaction delegate",
    log: params.log ?? defaultRecoveryLog,
    stateDir: params.stateDir,
    deliver: async (entry) => {
      if (!isPostCompactionDelegateEntry(entry)) {
        return;
      }
      await deliverQueuedPostCompactionDelegate({ entry }, params.deliveryDeps);
    },
    selectEntry: (entry) => ({
      match:
        isPostCompactionDelegateEntry(entry) &&
        (params.sessionKey == null || entry.sessionKey === params.sessionKey) &&
        (entryIds.size === 0 || entryIds.has(entry.id)),
      bypassBackoff: entryIds.size > 0,
    }),
  });
}

export async function dispatchPostCompactionDelegates(
  params: DispatchPostCompactionDelegatesParams,
  deps: PostCompactionDelegateDispatchDeps = defaultPostCompactionDelegateDispatchDeps,
): Promise<DispatchPostCompactionDelegatesResult> {
  const stagedCompactionDelegates = deps.consumeStagedPostCompactionDelegates(params.sessionKey);
  let persistedCompactionDelegates: SessionPostCompactionDelegate[] = [];
  try {
    persistedCompactionDelegates = await takePendingPostCompactionDelegates({
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    deps.log(`Failed to load post-compaction delegates for ${params.sessionKey}: ${message}`);
    enqueueSystemEventOrLog({
      deps,
      label: "persisted post-compaction delegate warning",
      sessionKey: params.sessionKey,
      text:
        `[system:continuation-warning] Failed to load persisted post-compaction delegates for this session: ${message}. ` +
        "Earlier turns may have staged delegates that will not fire. Re-stage critical post-compaction work.",
    });
  }
  const allCompactionDelegates = [
    ...persistedCompactionDelegates,
    ...stagedCompactionDelegates,
  ].map(normalizePostCompactionDelegate);
  const now = deps.now();
  const freshCompactionDelegates: SessionPostCompactionDelegate[] = [];
  let staleDroppedDelegates = 0;
  for (const delegate of allCompactionDelegates) {
    const ageMs = now - (delegate.firstArmedAt ?? delegate.createdAt);
    if (ageMs > POST_COMPACTION_DELEGATE_TTL_MS) {
      staleDroppedDelegates += 1;
      deps.log(
        `Post-compaction delegate dropped as stale for ${params.sessionKey}: ageMs=${ageMs} ttlMs=${POST_COMPACTION_DELEGATE_TTL_MS} firstArmedAt=${delegate.firstArmedAt ?? delegate.createdAt} task=${formatTaskPreview(delegate.task)}`,
      );
      continue;
    }
    freshCompactionDelegates.push(delegate);
  }

  // Enforce maxDelegatesPerTurn budget. Account for any bracket-style delegate
  // already spawned this turn so the combined per-turn count cannot exceed
  // the configured cap. Mirrors the pre-extraction behavior at
  // src/auto-reply/reply/agent-runner.ts (pre-cdc9b6ecd54).
  const { maxDelegatesPerTurn: maxCompactionDelegates } = deps.resolveContinuationRuntimeConfig(
    params.cfg,
  );
  const bracketDelegateOffset = params.continuationSignalKind === "delegate" ? 1 : 0;
  const compactionBudget = Math.max(0, maxCompactionDelegates - bracketDelegateOffset);
  const releasedCompactionDelegates = freshCompactionDelegates.slice(0, compactionBudget);
  const overflowDroppedDelegates = Math.max(
    0,
    freshCompactionDelegates.length - releasedCompactionDelegates.length,
  );
  if (overflowDroppedDelegates > 0) {
    deps.log(
      `Post-compaction delegates dropped for ${params.sessionKey}: ${overflowDroppedDelegates} over maxDelegatesPerTurn budget (${maxCompactionDelegates}, bracketOffset=${bracketDelegateOffset})`,
    );
  }

  deps
    .readPostCompactionContext(
      typeof params.followupRun.run.workspaceDir === "string" &&
        params.followupRun.run.workspaceDir.trim()
        ? params.followupRun.run.workspaceDir
        : deps.resolveAgentWorkspaceDir(params.cfg, params.followupRun.run.agentId),
      {
        cfg: params.cfg,
        agentId: deps.resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
      },
    )
    .then((contextContent) => {
      if (contextContent) {
        deps.enqueueSystemEvent(contextContent, { sessionKey: params.sessionKey });
      }
    })
    .catch((err) => {
      const message = formatErrorMessage(err);
      deps.log(
        `[continuation:post-compaction-context-read-failed] sessionKey=${params.sessionKey} error=${message}`,
      );
      enqueueSystemEventOrLog({
        deps,
        label: "post-compaction context read failure",
        sessionKey: params.sessionKey,
        text:
          `[system:post-compaction] Context evacuation read failed: ${message}. ` +
          "The post-compaction session may be missing AGENTS.md/RESUMPTION.md content. Check workspace permissions and re-run if needed.",
      });
    });

  const deliveryContext = resolvePostCompactionDeliveryContext(params.followupRun);
  const enqueueResults = await Promise.allSettled(
    releasedCompactionDelegates.map((delegate, sequence) =>
      deps.enqueuePostCompactionDelegateDelivery({
        sessionKey: params.sessionKey,
        delegate,
        sequence,
        compactionCount: params.compactionCount,
        ...(deliveryContext ? { deliveryContext } : {}),
      }),
    ),
  );

  const queuedEntryIds: string[] = [];
  let droppedCompactionDelegates = staleDroppedDelegates + overflowDroppedDelegates;
  for (const [index, result] of enqueueResults.entries()) {
    if (result.status === "fulfilled") {
      queuedEntryIds.push(result.value);
      continue;
    }
    droppedCompactionDelegates += 1;
    const delegate = releasedCompactionDelegates[index];
    if (delegate) {
      params.postCompactionDelegatesToPreserve.push(delegate);
    }
    deps.log(
      `Failed to enqueue post-compaction delegate for ${params.sessionKey} (re-staged): ${String(
        result.reason,
      )}`,
    );
  }

  if (params.postCompactionDelegatesToPreserve.length > 0) {
    try {
      await persistPendingPostCompactionDelegates({
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        delegates: params.postCompactionDelegatesToPreserve,
      });
      params.postCompactionDelegatesToPreserve.length = 0;
    } catch (err) {
      deps.log(
        `Failed to persist re-staged post-compaction delegates for ${params.sessionKey} (${params.postCompactionDelegatesToPreserve.length}): ${String(
          err,
        )}`,
      );
    }
  }

  deps.enqueueSystemEvent(
    buildPostCompactionLifecycleEvent({
      compactionCount: params.compactionCount,
      queuedDelegates: queuedEntryIds.length,
      droppedDelegates: droppedCompactionDelegates,
    }),
    { sessionKey: params.sessionKey },
  );

  if (queuedEntryIds.length > 0) {
    // Drain unfiltered for this sessionKey: the prior `entryIds`-filtered
    // drain stranded any failed `pending/` entries from earlier turns —
    // they were never re-selected because the filter excluded their ids,
    // and only startup recovery would rescue them. With `entryIds`
    // omitted, `selectEntry` falls back to the sessionKey filter and
    // backoff-eligible failed retries are reconsidered alongside the
    // entries we just enqueued.
    void deps
      .drainPostCompactionDelegateDeliveries({
        log: defaultRecoveryLog,
        sessionKey: params.sessionKey,
      })
      .catch((err) => {
        deps.log(
          `Failed to drain queued post-compaction delegates for ${params.sessionKey}: ${String(
            err,
          )}`,
        );
      });
  }

  return {
    queuedDelegates: queuedEntryIds.length,
    droppedDelegates: droppedCompactionDelegates,
  };
}
