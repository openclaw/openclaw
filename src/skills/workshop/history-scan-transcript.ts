import { filterHeartbeatTranscriptTurns } from "../../auto-reply/heartbeat-transcript-turns.js";
import { readTranscriptStatsSync } from "../../config/sessions/session-accessor.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { formatSkillExperienceReviewTranscript } from "./experience-review-prompt.js";
import type { SkillHistoryScanCandidate } from "./history-scan-candidates.js";
import type { SkillHistoryScanPromptSession } from "./history-scan-prompt.js";

export const HISTORY_SCAN_MAX_CANDIDATES = 60;
export const HISTORY_SCAN_MAX_SESSIONS = 20;
export const HISTORY_SCAN_MAX_TRANSCRIPT_CHARS = 80_000;
export const HISTORY_SCAN_MAX_SESSION_CHARS = 16_000;
export const HISTORY_SCAN_SESSION_OVERHEAD_CHARS = 256;
const HISTORY_SCAN_MAX_RECENT_MESSAGES = 80;
const HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const HISTORY_SCAN_DEFAULT_CONTEXT_TOKENS = 8_192;
const HISTORY_SCAN_MIN_MODEL_ITERATIONS = 6;

function countModelIterations(messages: readonly unknown[]): number {
  return messages.reduce<number>((count, message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return count;
    }
    return count + ((message as { role?: unknown }).role === "assistant" ? 1 : 0);
  }, 0);
}

function capSessionTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }
  const omission = "\n\n[older session content omitted]\n\n";
  if (maxChars <= omission.length) {
    return transcript.slice(0, maxChars);
  }
  const contentBudget = Math.max(0, maxChars - omission.length);
  const headLength = Math.min(2_000, Math.floor(contentBudget / 2));
  const head = transcript.slice(0, headLength);
  const tail = transcript.slice(-(contentBudget - headLength));
  return `${head}\n\n[older session content omitted]\n\n${tail}`;
}

export function hasLegacyHookTranscriptContent(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      (message as { role?: unknown }).role !== "user"
    ) {
      return false;
    }
    const rendered = formatSkillExperienceReviewTranscript([message]);
    return (
      (rendered.includes("<<<EXTERNAL_UNTRUSTED_CONTENT") &&
        /(?:^|\n)Source: (?:Email|Webhook)(?:\n|$)/.test(rendered)) ||
      /(?:^|\n)\[cron:[^\]\n]+\](?: |$)/.test(rendered)
    );
  });
}

export function resolveSkillHistoryScanTranscriptBudget(contextTokens?: number): number {
  const effectiveContextTokens =
    Number.isFinite(contextTokens) && (contextTokens ?? 0) > 0
      ? Math.floor(contextTokens as number)
      : HISTORY_SCAN_DEFAULT_CONTEXT_TOKENS;
  return Math.min(
    HISTORY_SCAN_MAX_TRANSCRIPT_CHARS,
    Math.max(256, Math.floor(effectiveContextTokens * 0.35)),
  );
}

export function formatSkillHistoryScanTranscript(
  messages: readonly unknown[],
  maxChars: number,
): string {
  // Redact the complete structure first. Truncating first can split a PEM or
  // other multiline secret so the remaining fragment no longer matches.
  return capSessionTranscript(
    // Provider-bound history uses mandatory built-in patterns. Operator log
    // redaction mode and custom pattern replacement cannot weaken this seam.
    redactSensitiveText(formatSkillExperienceReviewTranscript(messages), { mode: "tools" }),
    maxChars,
  );
}

function filterSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): readonly unknown[] | undefined {
  if (hasLegacyHookTranscriptContent(messages)) {
    return undefined;
  }
  const roleMessages = messages.filter((message): message is { role: string; content?: unknown } =>
    Boolean(
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      typeof (message as { role?: unknown }).role === "string",
    ),
  );
  return filterHeartbeatTranscriptTurns(roleMessages, heartbeatPrompt);
}

export function selectSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): readonly unknown[] | undefined {
  return prepareSkillHistoryScanReviewMessages(messages, heartbeatPrompt)?.messages;
}

export function prepareSkillHistoryScanReviewMessages(
  messages: readonly unknown[],
  heartbeatPrompt?: string,
): { messages: readonly unknown[]; modelIterations: number } | undefined {
  const filtered = filterSkillHistoryScanReviewMessages(messages, heartbeatPrompt);
  if (!filtered) {
    return undefined;
  }
  return {
    messages: filtered.slice(-HISTORY_SCAN_MAX_RECENT_MESSAGES),
    modelIterations: countModelIterations(filtered),
  };
}

export function isSkillHistoryScanLocalTranscriptSizeEligible(sizeBytes: number): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    sizeBytes >= 0 &&
    sizeBytes <= HISTORY_SCAN_MAX_LOCAL_TRANSCRIPT_BYTES
  );
}

export async function readHistoryScanSession(params: {
  agentId: string;
  candidate: SkillHistoryScanCandidate;
  heartbeatPrompt: string;
  maxTranscriptChars: number;
  storePath: string;
}): Promise<SkillHistoryScanPromptSession | undefined> {
  const transcriptScope = {
    agentId: params.agentId,
    sessionId: params.candidate.entry.sessionId,
    sessionKey: params.candidate.sessionKey,
    sessionEntry: params.candidate.entry,
    storePath: params.storePath,
  };
  // Legacy rows may predate explicit hook provenance. Inspect every local turn
  // before choosing a bounded provider-facing window so old hook payloads can
  // never age out of the exclusion check.
  if (
    !isSkillHistoryScanLocalTranscriptSizeEligible(
      readTranscriptStatsSync(transcriptScope).sizeBytes,
    )
  ) {
    return undefined;
  }
  const allMessages = await readSessionMessagesAsync(transcriptScope, {
    mode: "full",
    reason: "Skill Workshop legacy hook provenance check",
  });
  const review = prepareSkillHistoryScanReviewMessages(allMessages, params.heartbeatPrompt);
  if (!review || review.modelIterations < HISTORY_SCAN_MIN_MODEL_ITERATIONS) {
    return undefined;
  }
  const transcript = formatSkillHistoryScanTranscript(review.messages, params.maxTranscriptChars);
  if (!transcript.trim()) {
    return undefined;
  }
  return {
    instanceId: params.candidate.instanceId,
    sessionKey: params.candidate.sessionKey,
    updatedAt: new Date(params.candidate.updatedAtMs).toISOString(),
    modelIterations: review.modelIterations,
    transcript,
  };
}

export async function collectSkillHistoryScanBatch(params: {
  candidates: readonly SkillHistoryScanCandidate[];
  isSessionActive?: (candidate: SkillHistoryScanCandidate) => boolean;
  maxTranscriptChars?: number;
  readSession: (
    candidate: SkillHistoryScanCandidate,
  ) => Promise<SkillHistoryScanPromptSession | undefined>;
}): Promise<{
  blockedByActive: boolean;
  considered: SkillHistoryScanCandidate[];
  sessions: SkillHistoryScanPromptSession[];
}> {
  const considered: SkillHistoryScanCandidate[] = [];
  const sessions: SkillHistoryScanPromptSession[] = [];
  const maxTranscriptChars = params.maxTranscriptChars ?? HISTORY_SCAN_MAX_TRANSCRIPT_CHARS;
  let blockedByActive = false;
  let transcriptChars = 0;
  for (const candidate of params.candidates.slice(0, HISTORY_SCAN_MAX_CANDIDATES)) {
    if (params.isSessionActive?.(candidate)) {
      blockedByActive = true;
      break;
    }
    const session = await params.readSession(candidate);
    // An active run can claim the session while its transcript is being read.
    // Stop before advancing the cursor so a later scan sees a stable snapshot.
    if (params.isSessionActive?.(candidate)) {
      blockedByActive = true;
      break;
    }
    if (
      session &&
      sessions.length > 0 &&
      transcriptChars + session.transcript.length + HISTORY_SCAN_SESSION_OVERHEAD_CHARS >
        maxTranscriptChars
    ) {
      break;
    }
    considered.push(candidate);
    if (!session) {
      continue;
    }
    sessions.push(session);
    transcriptChars += session.transcript.length + HISTORY_SCAN_SESSION_OVERHEAD_CHARS;
    if (sessions.length >= HISTORY_SCAN_MAX_SESSIONS) {
      break;
    }
  }
  return { blockedByActive, considered, sessions };
}
