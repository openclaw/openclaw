import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { isHeartbeatUserMessage } from "../auto-reply/heartbeat-filter.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import {
  resolveSessionFilePathCore,
  type resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { updateLegacySessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { clearTuiLastSessionPointers } from "../tui/tui-last-session.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { countLabel } from "./doctor-state-integrity-format.js";

const TRANSCRIPT_SCAN_CHUNK_BYTES = 64 * 1024;
// Cap incomplete/complete JSONL records so a missing newline or huge line cannot
// recreate full-file allocation after chunked reads. Oversized records fail closed.
const TRANSCRIPT_RECORD_MAX_CHARS = 256 * 1024;

type HeartbeatMainSessionStore =
  | { kind: "legacy"; path: string }
  | { kind: "sqlite"; agentId: string; path: string };

type TranscriptHeartbeatSummary = {
  heartbeatUserMessages: number;
  nonHeartbeatUserMessages: number;
};

function accumulateTranscriptHeartbeatMessage(
  summary: TranscriptHeartbeatSummary,
  line: string,
): void {
  const record = asNullableObjectRecord(safeParseJson(line.trim()));
  const message = asNullableObjectRecord(record?.message) ?? record;
  if (message?.role !== "user") {
    return;
  }
  if (isHeartbeatUserMessage({ role: message.role, content: message.content })) {
    summary.heartbeatUserMessages += 1;
  } else {
    summary.nonHeartbeatUserMessages += 1;
  }
}

// Chunked reads bound memory even for poisoned transcripts; oversized records decline repair.
function scanTranscriptHeartbeatMessages(
  transcriptPath: string,
): TranscriptHeartbeatSummary | "record-too-large" | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  const summary: TranscriptHeartbeatSummary = {
    heartbeatUserMessages: 0,
    nonHeartbeatUserMessages: 0,
  };
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(TRANSCRIPT_SCAN_CHUNK_BYTES);
    let carry = "";
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) {
        break;
      }
      carry += decoder.write(chunk.subarray(0, bytesRead));
      let newline = carry.indexOf("\n");
      while (newline >= 0) {
        if (newline > TRANSCRIPT_RECORD_MAX_CHARS) {
          return "record-too-large";
        }
        const line = carry.slice(0, newline).replace(/\r$/, "");
        carry = carry.slice(newline + 1);
        accumulateTranscriptHeartbeatMessage(summary, line);
        newline = carry.indexOf("\n");
      }
      if (carry.length > TRANSCRIPT_RECORD_MAX_CHARS) {
        return "record-too-large";
      }
    }
    carry += decoder.end();
    if (carry.length > TRANSCRIPT_RECORD_MAX_CHARS) {
      return "record-too-large";
    }
    if (carry) {
      accumulateTranscriptHeartbeatMessage(summary, carry.replace(/\r$/, ""));
    }
  } finally {
    fs.closeSync(fd);
  }
  return summary;
}

// Older stores can contain only heartbeat turns without the isolation marker.
function resolveHeartbeatMainSessionRepairCandidate(params: {
  entry: SessionEntry | undefined;
  transcriptPath?: string;
}): { reason: string } | "record-too-large" | null {
  const { entry, transcriptPath } = params;
  if (!entry || entry.lastInteractionAt !== undefined) {
    return null;
  }
  const hasSyntheticHeartbeatOwnership =
    typeof entry.heartbeatIsolatedBaseSessionKey === "string" &&
    entry.heartbeatIsolatedBaseSessionKey.trim().length > 0;
  if (!transcriptPath) {
    return hasSyntheticHeartbeatOwnership ? { reason: "heartbeat metadata" } : null;
  }
  const summary = scanTranscriptHeartbeatMessages(transcriptPath);
  if (summary === "record-too-large") {
    return summary;
  }
  if (!summary) {
    return null;
  }
  if (summary.heartbeatUserMessages > 0 && summary.nonHeartbeatUserMessages === 0) {
    // A human message must block repair; moving a real conversation would break resume semantics.
    return {
      reason: hasSyntheticHeartbeatOwnership
        ? "heartbeat metadata"
        : `${summary.heartbeatUserMessages} heartbeat-only user message(s)`,
    };
  }
  return null;
}

function resolveHeartbeatMainRecoveryKey(params: {
  mainKey: string;
  isSessionKeyOccupied: (sessionKey: string) => boolean;
  nowMs?: number;
}): string | null {
  const parsed = parseAgentSessionKey(params.mainKey);
  if (!parsed) {
    return null;
  }
  const stamp = formatSessionArchiveTimestamp(params.nowMs).toLowerCase();
  const base = `agent:${parsed.agentId}:heartbeat-recovered-${stamp}`;
  for (let index = 1; index <= 100; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    if (!params.isSessionKeyOccupied(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Recheck inside the update transaction so concurrent human activity prevents archival.
export async function repairHeartbeatPoisonedMainSession(params: {
  mainKey: string;
  mainEntry?: SessionEntry;
  isSessionKeyOccupied: (sessionKey: string) => boolean;
  store: HeartbeatMainSessionStore;
  stateDir: string;
  sessionPathOpts: ReturnType<typeof resolveSessionFilePathOptions>;
  prompter: Pick<DoctorPrompter, "confirmRuntimeRepair">;
  warnings: string[];
  changes: string[];
}): Promise<boolean> {
  const mainKey = params.mainKey;
  const mainEntry = params.mainEntry;
  if (!mainEntry?.sessionId) {
    return false;
  }
  let transcriptPath: string | undefined;
  try {
    transcriptPath = resolveSessionFilePathCore(
      mainEntry.sessionId,
      mainEntry,
      params.sessionPathOpts,
    );
  } catch {
    transcriptPath = undefined;
  }
  if (transcriptPath && !fs.existsSync(transcriptPath)) {
    transcriptPath = undefined;
  }
  const candidate = resolveHeartbeatMainSessionRepairCandidate({
    entry: mainEntry,
    transcriptPath,
  });
  if (!candidate) {
    return false;
  }
  if (candidate === "record-too-large") {
    params.warnings.push(
      `- Skipped heartbeat main-session recovery for ${mainKey}: the transcript contains a JSONL record larger than ${TRANSCRIPT_RECORD_MAX_CHARS} characters, so doctor left it unchanged.`,
    );
    return false;
  }
  const recoveredKey = resolveHeartbeatMainRecoveryKey({
    mainKey,
    isSessionKeyOccupied: params.isSessionKeyOccupied,
  });
  if (!recoveredKey) {
    params.warnings.push(
      `- Main session ${mainKey} appears heartbeat-owned, but doctor could not choose a safe recovery key.`,
    );
    return false;
  }
  params.warnings.push(
    [
      `- Main session ${mainKey} appears to be a heartbeat-owned session (${candidate.reason}).`,
      `  Doctor can move it to ${recoveredKey} and let the next interactive launch create a fresh main session.`,
    ].join("\n"),
  );
  const shouldRepair = await params.prompter.confirmRuntimeRepair({
    message: `Move heartbeat-owned main session ${mainKey} to ${recoveredKey} and clear stale TUI restore pointers?`,
    initialValue: true,
  });
  if (!shouldRepair) {
    return false;
  }
  let movedEntry: SessionEntry | undefined;
  if (params.store.kind === "sqlite") {
    const result = await applySessionEntryLifecycleMutation({
      agentId: params.store.agentId,
      removals: [
        {
          archiveRemovedTranscript: false,
          expectedEntry: mainEntry,
          sessionKey: mainKey,
        },
      ],
      skipMaintenance: true,
      storePath: params.store.path,
      upserts: [{ entry: mainEntry, requiresRemovalSessionKey: mainKey, sessionKey: recoveredKey }],
    });
    if (result.removedSessionKeys.includes(mainKey)) {
      movedEntry = mainEntry;
    }
  } else {
    await updateLegacySessionStore(params.store.path, (currentStore) => {
      const currentEntry = currentStore[mainKey];
      const currentCandidate = resolveHeartbeatMainSessionRepairCandidate({
        entry: currentEntry,
        transcriptPath,
      });
      if (!currentCandidate || currentCandidate === "record-too-large") {
        return;
      }
      if (currentEntry && !currentStore[recoveredKey]) {
        currentStore[recoveredKey] = currentEntry;
        delete currentStore[mainKey];
        movedEntry = currentEntry;
      }
    });
  }
  if (!movedEntry) {
    params.warnings.push(`- Main session ${mainKey} changed before repair could move it.`);
    return false;
  }
  let clearedPointers = 0;
  try {
    clearedPointers = await clearTuiLastSessionPointers({
      stateDir: params.stateDir,
      sessionKeys: new Set([mainKey]),
    });
  } catch (error) {
    params.warnings.push(
      `- Moved heartbeat-owned main session ${mainKey}, but could not clear its TUI restore pointers: ${String(error)}`,
    );
  }
  params.changes.push(`- Moved heartbeat-owned main session ${mainKey} to ${recoveredKey}.`);
  if (clearedPointers > 0) {
    params.changes.push(
      `- Cleared ${countLabel(clearedPointers, "stale TUI last-session pointer")} for ${mainKey}.`,
    );
  }
  return true;
}
