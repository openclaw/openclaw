import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { estimateMessagesTokens } from "../agents/compaction.js";
import {
  resolveCacheTtlMs,
  resolveTimeBasedContextCompactMode,
  type TimeBasedContextCompactMode,
} from "../agents/pi-embedded-runner/cache-ttl.js";
import { resolveExtraParams } from "../agents/pi-embedded-runner/extra-params.js";
import { compactEmbeddedPiSession, isEmbeddedPiRunActive } from "../agents/pi-embedded.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveFreshSessionTotalTokens,
  type SessionEntry,
  type SessionStoreTarget,
  updateSessionStore,
} from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { performGatewaySessionReset } from "./session-reset-service.js";
import { readSessionMessages, resolveSessionModelRef } from "./session-utils.js";

const log = createSubsystemLogger("gateway/session-cache-maintenance");

const DEFAULT_IDLE_COMPACTION_MIN_TOKENS = 20_000;
const DEFAULT_IDLE_COMPACTION_LEAD_MS = 60_000;

type SessionCacheMaintenancePolicy = {
  mode: TimeBasedContextCompactMode;
  cacheTtlMs: number | null;
  idleCompactionMinTokens: number;
  idleCompactionLeadMs: number;
};

type SessionCacheTimingState = Pick<
  SessionEntry,
  | "lastUserMessageAt"
  | "lastAssistantMessageAt"
  | "lastCacheTouchAt"
  | "lastIdleCompactionForCacheTouchAt"
>;

function resolvePositiveTimestamp(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveCacheTouchAt(entry: SessionCacheTimingState): number | null {
  return (
    resolvePositiveTimestamp(entry.lastCacheTouchAt) ??
    resolvePositiveTimestamp(entry.lastAssistantMessageAt)
  );
}

function isAwaitingUserReply(entry: SessionCacheTimingState): boolean {
  const lastAssistant = resolvePositiveTimestamp(entry.lastAssistantMessageAt);
  if (lastAssistant == null) {
    return false;
  }
  const lastUser = resolvePositiveTimestamp(entry.lastUserMessageAt);
  return lastUser == null || lastAssistant > lastUser;
}

function resolveIdleCompactionThresholdMs(policy: SessionCacheMaintenancePolicy): number | null {
  if (policy.cacheTtlMs == null) {
    return null;
  }
  const thresholdMs = policy.cacheTtlMs - policy.idleCompactionLeadMs;
  return thresholdMs > 0 ? thresholdMs : null;
}

export function shouldResetExpiredSession(params: {
  entry: SessionCacheTimingState;
  policy: SessionCacheMaintenancePolicy;
  now: number;
}): boolean {
  if (!isAwaitingUserReply(params.entry) || params.policy.cacheTtlMs == null) {
    return false;
  }
  if (params.policy.mode !== "reset") {
    return false;
  }
  const cacheTouchAt = resolveCacheTouchAt(params.entry);
  return cacheTouchAt != null && params.now - cacheTouchAt >= params.policy.cacheTtlMs;
}

export function shouldRunIdleCacheCompaction(params: {
  entry: SessionCacheTimingState;
  policy: SessionCacheMaintenancePolicy;
  now: number;
  totalTokens?: number;
}): boolean {
  if (!isAwaitingUserReply(params.entry)) {
    return false;
  }
  if (params.policy.mode !== "compact") {
    return false;
  }
  const cacheTouchAt = resolveCacheTouchAt(params.entry);
  const idleThresholdMs = resolveIdleCompactionThresholdMs(params.policy);
  if (cacheTouchAt == null || idleThresholdMs == null) {
    return false;
  }
  if (params.entry.lastIdleCompactionForCacheTouchAt === cacheTouchAt) {
    return false;
  }
  if (params.now - cacheTouchAt >= (params.policy.cacheTtlMs ?? 0)) {
    return false;
  }
  if (params.now - cacheTouchAt < idleThresholdMs) {
    return false;
  }
  return (params.totalTokens ?? 0) >= params.policy.idleCompactionMinTokens;
}

function resolveSessionCacheMaintenancePolicy(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
  target: SessionStoreTarget;
}): SessionCacheMaintenancePolicy {
  const agentId =
    params.target.agentId ||
    resolveAgentIdFromSessionKey(params.sessionKey) ||
    resolveDefaultAgentId(params.cfg);
  const { provider, model } = resolveSessionModelRef(params.cfg, params.entry, agentId);
  const extraParams = resolveExtraParams({
    cfg: params.cfg,
    provider,
    modelId: model,
    agentId,
  });
  return {
    mode: resolveTimeBasedContextCompactMode(extraParams),
    cacheTtlMs: resolveCacheTtlMs({
      config: params.cfg,
      provider,
      modelId: model,
      agentId,
    }),
    idleCompactionMinTokens: DEFAULT_IDLE_COMPACTION_MIN_TOKENS,
    idleCompactionLeadMs: DEFAULT_IDLE_COMPACTION_LEAD_MS,
  };
}

function estimateSessionTotalTokens(params: {
  entry: SessionEntry;
  target: SessionStoreTarget;
}): number | undefined {
  const freshTokens = resolveFreshSessionTotalTokens(params.entry);
  if (typeof freshTokens === "number" && freshTokens > 0) {
    return freshTokens;
  }
  const fallbackTokens =
    typeof params.entry.totalTokens === "number" && params.entry.totalTokens > 0
      ? params.entry.totalTokens
      : undefined;
  if (fallbackTokens !== undefined) {
    return fallbackTokens;
  }
  if (!params.entry.sessionId) {
    return undefined;
  }
  try {
    const messages = readSessionMessages(
      params.entry.sessionId,
      params.target.storePath,
      params.entry.sessionFile,
    );
    if (messages.length === 0) {
      return undefined;
    }
    const estimated = estimateMessagesTokens(messages as AgentMessage[]);
    return Number.isFinite(estimated) && estimated > 0 ? Math.ceil(estimated) : undefined;
  } catch {
    return undefined;
  }
}

async function persistSessionMaintenancePatch(params: {
  target: SessionStoreTarget;
  sessionKey: string;
  patch: Partial<SessionEntry>;
}) {
  await updateSessionStore(params.target.storePath, (store) => {
    const current = store[params.sessionKey];
    if (!current) {
      return;
    }
    store[params.sessionKey] = {
      ...current,
      ...params.patch,
    };
  });
}

async function maybeCompactIdleSession(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
  target: SessionStoreTarget;
  now: number;
  totalTokens: number;
}): Promise<boolean> {
  const cacheTouchAt = resolveCacheTouchAt(params.entry);
  if (cacheTouchAt == null || !params.entry.sessionFile) {
    return false;
  }
  const agentId =
    params.target.agentId ||
    resolveAgentIdFromSessionKey(params.sessionKey) ||
    resolveDefaultAgentId(params.cfg);
  const { provider, model } = resolveSessionModelRef(params.cfg, params.entry, agentId);
  const result = await compactEmbeddedPiSession({
    sessionId: params.entry.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.entry.sessionFile,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
    agentDir: resolveAgentDir(params.cfg, agentId),
    config: params.cfg,
    skillsSnapshot: params.entry.skillsSnapshot,
    provider,
    model,
    trigger: "manual",
    currentTokenCount: params.totalTokens,
  });

  const patch: Partial<SessionEntry> = {
    lastIdleCompactionForCacheTouchAt: cacheTouchAt,
  };
  if (result.ok && result.compacted) {
    patch.compactionCount = (params.entry.compactionCount ?? 0) + 1;
    patch.lastCacheTouchAt = params.now;
    if (typeof result.result?.tokensAfter === "number" && result.result.tokensAfter > 0) {
      patch.totalTokens = result.result.tokensAfter;
      patch.totalTokensFresh = true;
    }
    log.info("idle cache-warming compaction completed", {
      sessionKey: params.sessionKey,
      provider,
      model,
      tokensBefore: params.totalTokens,
      tokensAfter: result.result?.tokensAfter,
    });
  } else {
    log.info("idle cache-warming compaction skipped", {
      sessionKey: params.sessionKey,
      provider,
      model,
      reason: result.reason ?? "not_compacted",
      tokens: params.totalTokens,
    });
  }
  await persistSessionMaintenancePatch({
    target: params.target,
    sessionKey: params.sessionKey,
    patch,
  });
  return true;
}

async function maybeResetExpiredSession(params: { sessionKey: string }): Promise<boolean> {
  const result = await performGatewaySessionReset({
    key: params.sessionKey,
    reason: "reset",
    commandSource: "gateway:session-cache-maintenance",
  });
  if (!result.ok) {
    log.warn(`expired-session reset skipped for ${params.sessionKey}: ${result.error.message}`);
    return false;
  }
  log.info("expired-session reset completed", { sessionKey: params.sessionKey });
  return true;
}

export async function runSessionCacheMaintenanceSweep(
  params: {
    cfg?: OpenClawConfig;
    nowMs?: () => number;
  } = {},
): Promise<void> {
  const cfg = params.cfg ?? loadConfig();
  const now = params.nowMs?.() ?? Date.now();
  const targets = resolveAllAgentSessionStoreTargetsSync(cfg);

  for (const target of targets) {
    const store = loadSessionStore(target.storePath);
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry?.sessionId || isEmbeddedPiRunActive(entry.sessionId)) {
        continue;
      }

      const policy = resolveSessionCacheMaintenancePolicy({
        cfg,
        entry,
        sessionKey,
        target,
      });
      if (policy.cacheTtlMs == null) {
        continue;
      }

      if (
        shouldResetExpiredSession({
          entry,
          policy,
          now,
        })
      ) {
        await maybeResetExpiredSession({ sessionKey });
        continue;
      }

      const totalTokens = estimateSessionTotalTokens({ entry, target });
      if (
        shouldRunIdleCacheCompaction({
          entry,
          policy,
          now,
          totalTokens,
        })
      ) {
        await maybeCompactIdleSession({
          cfg,
          entry,
          sessionKey,
          target,
          now,
          totalTokens: totalTokens ?? 0,
        });
      }
    }
  }
}
