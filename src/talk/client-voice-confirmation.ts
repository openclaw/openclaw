/** Server-owned confirmation binding for high-impact actions requested through Talk. */
import { createHash, randomUUID } from "node:crypto";
import { buildToolMutationState } from "../agents/tool-mutation.js";

const CONFIRMATION_TTL_MS = 2 * 60_000;

type PendingVoiceConfirmation = {
  confirmationId: string;
  voiceSessionId: string;
  sessionKey: string;
  fingerprint: string;
  toolName: string;
  createdAt: number;
  expiresAt: number;
};

type RecentVoiceUserTranscript = {
  voiceSessionId: string;
  sessionKey: string;
  text: string;
  timestamp: number;
};

const activeVoiceSessionBySessionKey = new Map<string, string>();
const recentUserTranscriptBySessionKey = new Map<string, RecentVoiceUserTranscript>();
const pendingConfirmations = new Map<string, PendingVoiceConfirmation>();
const approvedFingerprints = new Map<string, Map<string, number>>();

function stableToolFingerprint(toolName: string, params: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return createHash("sha256")
    .update(`${toolName}\0${JSON.stringify(normalize(params))}`)
    .digest("hex");
}

function requiresHighImpactVoiceConfirmation(toolName: string, params: unknown): boolean {
  const normalizedTool = toolName.trim().toLowerCase();
  const mutation = buildToolMutationState(normalizedTool, params);
  if (!mutation.mutatingAction) {
    return false;
  }
  if (
    ["message", "gateway", "nodes", "browser", "computer", "canvas", "cron"].includes(
      normalizedTool,
    )
  ) {
    return true;
  }
  if (normalizedTool === "process") {
    return true;
  }
  if (normalizedTool === "exec" || normalizedTool === "bash") {
    const record =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    const command = typeof record.command === "string" ? record.command : record.cmd;
    return typeof command === "string" && HIGH_IMPACT_SHELL_PATTERN.test(command);
  }
  if (
    [
      "write",
      "edit",
      "apply_patch",
      "create_goal",
      "update_goal",
      "sessions_spawn",
      "sessions_send",
    ].includes(normalizedTool)
  ) {
    return false;
  }
  return true;
}

const HIGH_IMPACT_SHELL_PATTERN =
  /\b(rm|rmdir|unlink|shred|truncate|dd|mkfs(?:\.[a-z0-9_-]+)?|chmod\s+-r|chown\s+-r|find\b[^\n]*\s-delete|sudo|su\s+-|systemctl|service\s+\S+\s+(start|stop|restart|reload)|shutdown|reboot|poweroff|halt|mount|umount|kill|pkill|killall|docker\s+(push|rm|rmi|stop|kill|restart|system\s+prune)|kubectl\s+(apply|create|delete|edit|patch|replace|rollout|scale)|terraform\s+(apply|destroy|import)|git\s+push|gh\s+(api|pr\s+(merge|close|comment|review)|issue\s+(create|close|comment)|release\s+(create|delete|upload))|npm\s+(publish|unpublish|deprecate)|pnpm\s+publish|yarn\s+npm\s+publish|cargo\s+publish|curl\b[^\n]*(?:-X|--request)\s*(POST|PUT|PATCH|DELETE)|curl\b[^\n]*(?:-d|--data(?:-raw|-binary|-urlencode)?)\b|wget\b[^\n]*--post-(?:data|file)|ssh\b\s+\S+\s+\S|scp\b|rsync\b[^\n]*\S+:|openclaw\s+(config\s+(set|unset)|gateway\s+(restart|stop|install|uninstall)|message\s+send))\b/i;

function consumeApprovedFingerprint(sessionKey: string, fingerprint: string, now: number): boolean {
  const approved = approvedFingerprints.get(sessionKey);
  const expiresAt = approved?.get(fingerprint);
  if (!expiresAt || expiresAt < now) {
    approved?.delete(fingerprint);
    return false;
  }
  approved?.delete(fingerprint);
  return true;
}

/** Mark one logical voice session as the origin of subsequent agent tool calls. */
export function activateClientVoiceConfirmationSession(params: {
  sessionKey: string;
  voiceSessionId: string;
}): void {
  activeVoiceSessionBySessionKey.set(params.sessionKey, params.voiceSessionId);
}

/** Remove ephemeral authorization state when a logical voice session closes. */
export function deactivateClientVoiceConfirmationSession(params: {
  sessionKey: string;
  voiceSessionId: string;
}): void {
  if (activeVoiceSessionBySessionKey.get(params.sessionKey) === params.voiceSessionId) {
    activeVoiceSessionBySessionKey.delete(params.sessionKey);
    recentUserTranscriptBySessionKey.delete(params.sessionKey);
    approvedFingerprints.delete(params.sessionKey);
  }
  for (const [confirmationId, confirmation] of pendingConfirmations) {
    if (confirmation.voiceSessionId === params.voiceSessionId) {
      pendingConfirmations.delete(confirmationId);
    }
  }
}

/** Record only ledger-validated final user transcript text for confirmation checks. */
export function noteClientVoiceConfirmationTranscript(params: {
  sessionKey: string;
  voiceSessionId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}): void {
  if (params.role !== "user") {
    return;
  }
  recentUserTranscriptBySessionKey.set(params.sessionKey, {
    voiceSessionId: params.voiceSessionId,
    sessionKey: params.sessionKey,
    text: params.text,
    timestamp: params.timestamp,
  });
}

/** Deterministically pause high-impact tool calls until the exact action is confirmed. */
export function resolveClientVoiceToolConfirmationPolicy(params: {
  sessionKey?: string;
  toolName: string;
  toolParams: unknown;
  now?: number;
}): { allowed: true } | { allowed: false; reason: string } {
  const sessionKey = params.sessionKey?.trim();
  const voiceSessionId = sessionKey ? activeVoiceSessionBySessionKey.get(sessionKey) : undefined;
  if (!sessionKey || !voiceSessionId) {
    return { allowed: true };
  }
  if (!requiresHighImpactVoiceConfirmation(params.toolName, params.toolParams)) {
    return { allowed: true };
  }
  const now = params.now ?? Date.now();
  const fingerprint = stableToolFingerprint(params.toolName, params.toolParams);
  if (consumeApprovedFingerprint(sessionKey, fingerprint, now)) {
    return { allowed: true };
  }
  const existing = [...pendingConfirmations.values()].find(
    (entry) =>
      entry.sessionKey === sessionKey &&
      entry.fingerprint === fingerprint &&
      entry.expiresAt >= now,
  );
  const confirmation =
    existing ??
    ({
      confirmationId: randomUUID(),
      voiceSessionId,
      sessionKey,
      fingerprint,
      toolName: params.toolName,
      createdAt: now,
      expiresAt: now + CONFIRMATION_TTL_MS,
    } satisfies PendingVoiceConfirmation);
  pendingConfirmations.set(confirmation.confirmationId, confirmation);
  return {
    allowed: false,
    reason:
      `VOICE_CONFIRMATION_REQUIRED:${confirmation.confirmationId} ` +
      `The high-impact voice action "${params.toolName}" was not executed. ` +
      "Ask the user for explicit spoken confirmation, then call openclaw_agent_consult again with this confirmationId.",
  };
}

function isExplicitAffirmation(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[,;:.!?]+/g, "")
    .replace(/\s+/g, " ");
  if (/\b(no|don't|do not|cancel|stop|never mind)\b/.test(normalized)) {
    return false;
  }
  return /^(yes|yes do it|do it|confirm|confirmed|go ahead|proceed|send it|make the change|restart it)$/.test(
    normalized,
  );
}

/** Bind a subsequent affirmative user utterance to one exact paused action. */
export function authorizeClientVoiceConfirmation(params: {
  sessionKey: string;
  voiceSessionId: string;
  confirmationId: string;
  now?: number;
}): void {
  const confirmation = pendingConfirmations.get(params.confirmationId);
  const now = params.now ?? Date.now();
  if (
    !confirmation ||
    confirmation.voiceSessionId !== params.voiceSessionId ||
    confirmation.sessionKey !== params.sessionKey ||
    confirmation.expiresAt < now
  ) {
    throw new Error("voice confirmation is missing, expired, or belongs to another action");
  }
  const affirmation = recentUserTranscriptBySessionKey.get(params.sessionKey);
  if (
    !affirmation ||
    affirmation.voiceSessionId !== params.voiceSessionId ||
    affirmation.timestamp <= confirmation.createdAt ||
    !isExplicitAffirmation(affirmation.text)
  ) {
    throw new Error("explicit spoken confirmation was not found after the action request");
  }
  const approved = approvedFingerprints.get(params.sessionKey) ?? new Map<string, number>();
  approved.set(confirmation.fingerprint, confirmation.expiresAt);
  approvedFingerprints.set(params.sessionKey, approved);
  pendingConfirmations.delete(params.confirmationId);
}

/** Test-only reset for module-global confirmation state. */
export function resetClientVoiceConfirmationStateForTest(): void {
  activeVoiceSessionBySessionKey.clear();
  recentUserTranscriptBySessionKey.clear();
  pendingConfirmations.clear();
  approvedFingerprints.clear();
}
