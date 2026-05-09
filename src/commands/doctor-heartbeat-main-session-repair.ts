import { isHeartbeatOkResponse, isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  upsertSessionEntry,
} from "../config/sessions/store.js";
import { loadSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatFilesystemTimestamp } from "../infra/filesystem-timestamp.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { asNullableObjectRecord } from "../shared/record-coerce.js";
import type { note } from "../terminal/note.js";
import { clearTuiLastSessionPointers as clearTuiLastSessionPointersFromState } from "../tui/tui-last-session.js";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: {
    message: string;
    initialValue?: boolean;
    requiresInteractiveConfirmation?: boolean;
  }) => Promise<boolean>;
  note?: typeof note;
};

type TranscriptHeartbeatSummary = {
  inspectedMessages: number;
  userMessages: number;
  heartbeatUserMessages: number;
  nonHeartbeatUserMessages: number;
  assistantMessages: number;
  heartbeatOkAssistantMessages: number;
};

export type HeartbeatMainSessionRepairCandidate = {
  reason: "metadata" | "transcript";
  summary?: TranscriptHeartbeatSummary;
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sessionEntryHasSyntheticHeartbeatOwnership(entry: SessionEntry): boolean {
  return (
    typeof entry.heartbeatIsolatedBaseSessionKey === "string" &&
    entry.heartbeatIsolatedBaseSessionKey.trim().length > 0
  );
}

function parseTranscriptMessageEvent(event: unknown): { role: string; content?: unknown } | null {
  const parsed = event;
  const record = asNullableObjectRecord(parsed);
  if (!record) {
    return null;
  }
  const nested = asNullableObjectRecord(record.message);
  const message = nested ?? record;
  const role = message.role;
  if (typeof role !== "string") {
    return null;
  }
  return { role, content: message.content };
}

function summarizeTranscriptHeartbeatMessages(transcriptScope: {
  agentId: string;
  sessionId: string;
}): TranscriptHeartbeatSummary | null {
  const events = loadSqliteSessionTranscriptEvents(transcriptScope);
  const summary: TranscriptHeartbeatSummary = {
    inspectedMessages: 0,
    userMessages: 0,
    heartbeatUserMessages: 0,
    nonHeartbeatUserMessages: 0,
    assistantMessages: 0,
    heartbeatOkAssistantMessages: 0,
  };
  for (const event of events) {
    const message = parseTranscriptMessageEvent(event.event);
    if (!message) {
      continue;
    }
    summary.inspectedMessages += 1;
    if (message.role === "user") {
      summary.userMessages += 1;
      if (isHeartbeatUserMessage(message)) {
        summary.heartbeatUserMessages += 1;
      } else {
        summary.nonHeartbeatUserMessages += 1;
      }
    } else if (message.role === "assistant") {
      summary.assistantMessages += 1;
      if (isHeartbeatOkResponse(message)) {
        summary.heartbeatOkAssistantMessages += 1;
      }
    }
  }
  return summary.inspectedMessages > 0 ? summary : null;
}

export function resolveHeartbeatMainSessionRepairCandidate(params: {
  entry: SessionEntry | undefined;
  transcriptScope?: { agentId: string; sessionId: string };
}): HeartbeatMainSessionRepairCandidate | null {
  const { entry, transcriptScope } = params;
  if (!entry) {
    return null;
  }
  const hasNoRecordedHumanInteraction = entry.lastInteractionAt === undefined;
  if (!hasNoRecordedHumanInteraction) {
    return null;
  }
  const hasSyntheticHeartbeatOwnership = sessionEntryHasSyntheticHeartbeatOwnership(entry);
  if (hasSyntheticHeartbeatOwnership && !transcriptScope) {
    return { reason: "metadata" };
  }
  if (!transcriptScope) {
    return null;
  }
  const summary = summarizeTranscriptHeartbeatMessages(transcriptScope);
  if (!summary) {
    return null;
  }
  if (
    summary.heartbeatUserMessages > 0 &&
    summary.userMessages === summary.heartbeatUserMessages &&
    summary.nonHeartbeatUserMessages === 0
  ) {
    return { reason: hasSyntheticHeartbeatOwnership ? "metadata" : "transcript", summary };
  }
  return null;
}

function resolveHeartbeatMainRecoveryKey(params: {
  mainKey: string;
  store: Record<string, SessionEntry>;
  nowMs?: number;
}): string | null {
  const parsed = parseAgentSessionKey(params.mainKey);
  if (!parsed) {
    return null;
  }
  const stamp = formatFilesystemTimestamp(params.nowMs).toLowerCase();
  const base = `agent:${parsed.agentId}:heartbeat-recovered-${stamp}`;
  if (!params.store[base]) {
    return base;
  }
  for (let index = 2; index <= 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!params.store[candidate]) {
      return candidate;
    }
  }
  return null;
}

export function moveHeartbeatMainSessionEntry(params: {
  store: Record<string, SessionEntry>;
  mainKey: string;
  recoveredKey: string;
}): boolean {
  const entry = params.store[params.mainKey];
  if (!entry || params.store[params.recoveredKey]) {
    return false;
  }
  params.store[params.recoveredKey] = entry;
  delete params.store[params.mainKey];
  return true;
}

export async function repairHeartbeatPoisonedMainSession(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  stateDir: string;
  sessionPathOpts: { agentId?: string };
  prompter: DoctorPrompterLike;
  warnings: string[];
  changes: string[];
}) {
  const mainKey = resolveMainSessionKey(params.cfg);
  const mainEntry = params.store[mainKey];
  if (!mainEntry?.sessionId) {
    return;
  }
  const transcriptScope =
    params.sessionPathOpts.agentId && mainEntry.sessionId
      ? { agentId: params.sessionPathOpts.agentId, sessionId: mainEntry.sessionId }
      : undefined;
  const resolveCandidate = (entry: SessionEntry | undefined) =>
    resolveHeartbeatMainSessionRepairCandidate({
      entry,
      transcriptScope,
    });
  const candidate = resolveCandidate(mainEntry);
  if (!candidate) {
    return;
  }
  const recoveredKey = resolveHeartbeatMainRecoveryKey({
    mainKey,
    store: params.store,
  });
  if (!recoveredKey) {
    params.warnings.push(
      `- Main session ${mainKey} appears heartbeat-owned, but doctor could not choose a safe recovery key.`,
    );
    return;
  }
  const reason =
    candidate.reason === "metadata"
      ? "heartbeat metadata"
      : `${candidate.summary?.heartbeatUserMessages ?? 0} heartbeat-only user message(s)`;
  params.warnings.push(
    [
      `- Main session ${mainKey} appears to be a heartbeat-owned session (${reason}).`,
      `  Doctor can move it to ${recoveredKey} and let the next interactive launch create a fresh main session.`,
    ].join("\n"),
  );
  const shouldRepair = await params.prompter.confirmRuntimeRepair({
    message: `Move heartbeat-owned main session ${mainKey} to ${recoveredKey} and clear stale TUI restore pointers?`,
    initialValue: true,
  });
  if (!shouldRepair) {
    return;
  }
  const agentId = parseAgentSessionKey(mainKey)?.agentId ?? "main";
  const currentEntry = getSessionEntry({ agentId, sessionKey: mainKey });
  const currentCandidate = resolveCandidate(currentEntry);
  if (!currentCandidate && currentEntry?.sessionId !== mainEntry.sessionId) {
    params.warnings.push(`- Main session ${mainKey} changed before repair could move it.`);
    return;
  }
  if (!currentEntry) {
    params.warnings.push(`- Main session ${mainKey} changed before repair could move it.`);
    return;
  }
  const movedEntry = structuredClone(currentEntry);
  upsertSessionEntry({
    agentId,
    sessionKey: recoveredKey,
    entry: movedEntry,
  });
  deleteSessionEntry({ agentId, sessionKey: mainKey });
  params.store[recoveredKey] = movedEntry;
  delete params.store[mainKey];
  const clearedPointers = await clearTuiLastSessionPointersFromState({
    stateDir: params.stateDir,
    sessionKeys: new Set([mainKey]),
  });
  params.changes.push(`- Moved heartbeat-owned main session ${mainKey} to ${recoveredKey}.`);
  if (clearedPointers > 0) {
    params.changes.push(
      `- Cleared ${countLabel(clearedPointers, "stale TUI last-session pointer")} for ${mainKey}.`,
    );
  }
}
