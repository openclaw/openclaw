import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { SessionEntry } from "./types.js";

const LIFECYCLE_KEYS = ["status", "startedAt", "endedAt", "runtimeMs", "abortedLastRun"] as const;

const REPLY_TURN_KEYS = [
  "replyTurnState",
  "replyTurnStartedAt",
  "replyTurnUpdatedAt",
  "replyTurnRunId",
  "replyTurnLastError",
] as const;

const RUNTIME_MODEL_KEYS = [
  "model",
  "modelProvider",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
] as const;

export type NormalChannelSessionExecutionStateIssue = {
  key: string;
  reasons: string[];
};

export function isInternalExecutionSessionEntry(params: {
  sessionKey: string;
  entry?: Partial<SessionEntry> | null;
}): boolean {
  const { sessionKey, entry } = params;
  if (
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey)
  ) {
    return true;
  }
  return Boolean(
    entry?.acp ||
    normalizeOptionalString(entry?.spawnedBy) ||
    normalizeOptionalString(entry?.parentSessionKey) ||
    typeof entry?.spawnDepth === "number",
  );
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function entryHasAny(entry: SessionEntry, keys: readonly (keyof SessionEntry)[]): boolean {
  return keys.some((key) => entry[key] !== undefined);
}

export function scanNormalChannelSessionExecutionState(
  store: Record<string, SessionEntry | undefined>,
): NormalChannelSessionExecutionStateIssue[] {
  const issues: NormalChannelSessionExecutionStateIssue[] = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || isInternalExecutionSessionEntry({ sessionKey: key, entry })) {
      continue;
    }
    const reasons: string[] = [];
    if (entryHasAny(entry, LIFECYCLE_KEYS)) {
      addReason(reasons, "run lifecycle fields");
    }
    if (entryHasAny(entry, REPLY_TURN_KEYS)) {
      addReason(reasons, "reply-turn fields");
    }
    if (
      entry.modelOverrideSource === "auto" ||
      entry.modelOverrideFallbackOriginProvider !== undefined ||
      entry.modelOverrideFallbackOriginModel !== undefined
    ) {
      addReason(reasons, "auto fallback pin");
    }
    if (entryHasAny(entry, RUNTIME_MODEL_KEYS)) {
      addReason(reasons, "cached runtime model fields");
    }
    if (entry.authProfileOverrideSource === "auto") {
      addReason(reasons, "auto auth profile pin");
    }
    if (reasons.length > 0) {
      issues.push({ key, reasons });
    }
  }
  return issues;
}

export function stripNormalChannelExecutionState(
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  if (isInternalExecutionSessionEntry({ sessionKey, entry })) {
    return entry;
  }

  let next = entry;
  const drop = <K extends keyof SessionEntry>(key: K) => {
    if (next[key] === undefined) {
      return;
    }
    if (next === entry) {
      next = { ...entry };
    }
    delete next[key];
  };

  for (const key of LIFECYCLE_KEYS) {
    drop(key);
  }
  for (const key of REPLY_TURN_KEYS) {
    drop(key);
  }
  for (const key of RUNTIME_MODEL_KEYS) {
    drop(key);
  }
  if (
    next.modelOverrideSource === "auto" ||
    next.modelOverrideFallbackOriginProvider !== undefined ||
    next.modelOverrideFallbackOriginModel !== undefined
  ) {
    drop("providerOverride");
    drop("modelOverride");
    drop("modelOverrideSource");
    drop("modelOverrideFallbackOriginProvider");
    drop("modelOverrideFallbackOriginModel");
  }
  if (next.authProfileOverrideSource === "auto") {
    drop("authProfileOverride");
    drop("authProfileOverrideSource");
    drop("authProfileOverrideCompactionCount");
  }
  return next;
}
