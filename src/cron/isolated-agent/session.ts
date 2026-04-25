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

const FRESH_CRON_SESSION_PRESERVED_FIELDS = [
  "heartbeatTaskState",
  "chatType",
  "thinkingLevel",
  "fastMode",
  "verboseLevel",
  "traceLevel",
  "reasoningLevel",
  "elevatedLevel",
  "ttsAuto",
  "responseUsage",
  "groupActivation",
  "groupActivationNeedsSystemIntro",
  "sendPolicy",
  "queueMode",
  "queueDebounceMs",
  "queueCap",
  "queueDrop",
  "label",
  "displayName",
  "channel",
  "groupId",
  "subject",
  "groupChannel",
  "space",
  "origin",
  "acp",
] as const satisfies readonly (keyof SessionEntry)[];

function cloneSessionField<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function clearFreshCronSessionState(entry: SessionEntry): SessionEntry {
  const next = {} as SessionEntry;

  for (const field of FRESH_CRON_SESSION_PRESERVED_FIELDS) {
    if (entry[field] !== undefined) {
      next[field] = cloneSessionField(entry[field]) as never;
    }
  }

  if (entry.modelOverrideSource !== "auto") {
    if (entry.modelOverride !== undefined) {
      next.modelOverride = entry.modelOverride;
    }
    if (entry.providerOverride !== undefined) {
      next.providerOverride = entry.providerOverride;
    }
    if (entry.modelOverrideSource !== undefined) {
      next.modelOverrideSource = entry.modelOverrideSource;
    }
  }

  if (entry.authProfileOverrideSource === "user") {
    if (entry.authProfileOverride !== undefined) {
      next.authProfileOverride = entry.authProfileOverride;
    }
    next.authProfileOverrideSource = entry.authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      next.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
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
