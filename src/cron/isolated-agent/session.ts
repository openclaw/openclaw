import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset-policy.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

function clearFreshCronSessionState(entry: SessionEntry): SessionEntry {
  const next = { ...entry };

  delete next.abortedLastRun;
  delete next.agentHarnessId;
  delete next.agentRuntimeOverride;
  delete next.cacheRead;
  delete next.cacheWrite;
  delete next.claudeCliSessionId;
  delete next.cliSessionBindings;
  delete next.cliSessionIds;
  delete next.contextTokens;
  delete next.deliveryContext;
  delete next.endedAt;
  delete next.estimatedCostUsd;
  delete next.execAsk;
  delete next.execHost;
  delete next.execNode;
  delete next.execSecurity;
  delete next.fallbackNoticeActiveModel;
  delete next.fallbackNoticeReason;
  delete next.fallbackNoticeSelectedModel;
  delete next.heartbeatIsolatedBaseSessionKey;
  delete next.inputTokens;
  delete next.lastAccountId;
  delete next.lastChannel;
  delete next.lastHeartbeatSentAt;
  delete next.lastHeartbeatText;
  delete next.lastThreadId;
  delete next.lastTo;
  delete next.liveModelSwitchPending;
  delete next.model;
  delete next.modelProvider;
  delete next.outputTokens;
  delete next.pluginDebugEntries;
  delete next.runtimeMs;
  delete next.sessionFile;
  delete next.startedAt;
  delete next.status;
  delete next.systemPromptReport;
  delete next.totalTokens;
  delete next.totalTokensFresh;

  if (next.modelOverrideSource === "auto") {
    delete next.modelOverride;
    delete next.providerOverride;
    delete next.modelOverrideSource;
  }

  if (next.authProfileOverrideSource !== "user") {
    delete next.authProfileOverride;
    delete next.authProfileOverrideSource;
    delete next.authProfileOverrideCompactionCount;
  }

  return next;
}

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: entry.updatedAt,
      now: params.nowMs,
      policy: resetPolicy,
    });

    if (freshness.fresh) {
      // Reuse existing session
      sessionId = entry.sessionId;
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  const previousSessionId = isNewSession ? entry?.sessionId : undefined;
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId,
  });

  const baseEntry = entry ? (isNewSession ? clearFreshCronSessionState(entry) : entry) : undefined;

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...baseEntry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession, previousSessionId };
}
